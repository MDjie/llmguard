package guardllm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var testSecret = []byte("go-sdk-test-secret-longer-than-thirty-two-bytes")

func TestSignatureBindsTraceAndSession(t *testing.T) {
	now := time.Now()
	identity := GatewayContext{
		TenantID: "tenant-1", ApplicationID: "application-1",
		PrincipalID: "user-1", CredentialID: "credential-1",
		RequestID: "request-1234", TraceID: "trace-1234567890123456",
		SessionID: "session-1", AbsoluteDeadlineEpochMs: now.Add(10 * time.Second).UnixMilli(),
	}
	signature, err := SignGatewayContext(identity, testSecret, now)
	if err != nil {
		t.Fatal(err)
	}
	tampered := identity
	tampered.TraceID = "trace-9999999999999999"
	tamperedSignature, err := SignGatewayContext(tampered, testSecret, now)
	if err != nil {
		t.Fatal(err)
	}
	if signature == tamperedSignature {
		t.Fatal("trace tampering did not change the signature")
	}
}

func TestChatAddsTrustedHeadersAndForcesNonStreaming(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Guard-Context-Version") != "3" ||
			request.Header.Get("X-Guard-Context-Signature") == "" {
			t.Error("trusted context headers are missing")
		}
		if request.Header.Get("X-Principal-Id") != "user-1" ||
			request.Header.Get("X-Credential-Id") != "credential-1" {
			t.Error("signed quota identity headers are missing")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["stream"] != false {
			t.Error("chat must force non-streaming mode")
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte("{\"choices\":[]}"))
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, TenantID: "tenant-1", ApplicationID: "application-1",
		CredentialID: "credential-1", ContextHMACSecret: testSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Chat(context.Background(), map[string]any{"model": "test"},
		ChatOptions{PrincipalID: "user-1"}); err != nil {
		t.Fatal(err)
	}
}

func TestChatStreamParsesEventsAndRejectsTruncation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = response.Write([]byte("event: message\ndata: {\"chunk\":1}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, TenantID: "tenant-1", ApplicationID: "application-1",
		ContextHMACSecret: testSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	var events []SSEEvent
	err = client.ChatStream(
		context.Background(), map[string]any{"model": "test"}, ChatOptions{},
		func(event SSEEvent) error {
			events = append(events, event)
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[1].Data != "[DONE]" {
		t.Fatalf("unexpected SSE events: %#v", events)
	}
	err = parseSSE(strings.NewReader("data: incomplete"), func(SSEEvent) error { return nil })
	if err == nil {
		t.Fatal("truncated SSE input was accepted")
	}
}
