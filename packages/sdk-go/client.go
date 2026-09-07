package guardllm

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	contextVersion = "3"
	maxDeadline    = 60 * time.Second
	maxResponse    = 16 * 1024 * 1024
)

type GatewayContext struct {
	TenantID                string
	ApplicationID           string
	PrincipalID             string
	CredentialID            string
	RequestID               string
	TraceID                 string
	SessionID               string
	AbsoluteDeadlineEpochMs int64
}

type Config struct {
	BaseURL           string
	TenantID          string
	ApplicationID     string
	CredentialID      string
	ContextHMACSecret []byte
	GuardAPIKey       string
	DefaultTimeout    time.Duration
	CAFile            string
	ClientCertificate string
	ClientPrivateKey  string
	HTTPClient        *http.Client
}

type ChatOptions struct {
	RequestID   string
	TraceID     string
	SessionID   string
	PrincipalID string
	Timeout     time.Duration
}

type SSEEvent struct {
	Event string
	ID    string
	Data  string
}

type Client struct {
	baseURL       *url.URL
	tenantID      string
	applicationID string
	credentialID  string
	secret        []byte
	guardAPIKey   string
	timeout       time.Duration
	httpClient    *http.Client
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimRight(config.BaseURL, "/"))
	if err != nil || baseURL.Hostname() == "" || baseURL.User != nil ||
		baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("guard gateway BaseURL is invalid")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && isLoopback(baseURL.Hostname())) {
		return nil, errors.New("guard gateway BaseURL must use HTTPS outside loopback development")
	}
	tenantID, err := bounded(config.TenantID, "TenantID", 1)
	if err != nil {
		return nil, err
	}
	applicationID, err := bounded(config.ApplicationID, "ApplicationID", 1)
	if err != nil {
		return nil, err
	}
	credentialID := ""
	if config.CredentialID != "" {
		credentialID, err = bounded(config.CredentialID, "CredentialID", 1)
		if err != nil {
			return nil, err
		}
	}
	if len(config.ContextHMACSecret) < 32 {
		return nil, errors.New("gateway context HMAC secret must contain at least 32 bytes")
	}
	timeout := config.DefaultTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	if timeout > maxDeadline {
		timeout = maxDeadline
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient, err = secureHTTPClient(config)
		if err != nil {
			return nil, err
		}
	} else if config.CAFile != "" || config.ClientCertificate != "" || config.ClientPrivateKey != "" {
		return nil, errors.New("TLS files cannot be combined with a custom HTTPClient")
	}
	return &Client{
		baseURL:       baseURL,
		tenantID:      tenantID,
		applicationID: applicationID,
		credentialID:  credentialID,
		secret:        append([]byte(nil), config.ContextHMACSecret...),
		guardAPIKey:   config.GuardAPIKey,
		timeout:       timeout,
		httpClient:    httpClient,
	}, nil
}

func SignaturePayload(identity GatewayContext) (string, error) {
	tenantID, err := bounded(identity.TenantID, "TenantID", 1)
	if err != nil {
		return "", err
	}
	applicationID, err := bounded(identity.ApplicationID, "ApplicationID", 1)
	if err != nil {
		return "", err
	}
	requestID, err := bounded(identity.RequestID, "RequestID", 8)
	if err != nil {
		return "", err
	}
	traceID, err := bounded(identity.TraceID, "TraceID", 16)
	if err != nil {
		return "", err
	}
	sessionID := ""
	if identity.SessionID != "" {
		sessionID, err = bounded(identity.SessionID, "SessionID", 1)
		if err != nil {
			return "", err
		}
	}
	principalID := ""
	if identity.PrincipalID != "" {
		principalID, err = bounded(identity.PrincipalID, "PrincipalID", 1)
		if err != nil {
			return "", err
		}
	}
	credentialID := ""
	if identity.CredentialID != "" {
		credentialID, err = bounded(identity.CredentialID, "CredentialID", 1)
		if err != nil {
			return "", err
		}
	}
	return strings.Join([]string{
		"guard-context-v3",
		tenantID,
		applicationID,
		principalID,
		credentialID,
		requestID,
		traceID,
		sessionID,
		strconv.FormatInt(identity.AbsoluteDeadlineEpochMs, 10),
	}, "\n"), nil
}

func SignGatewayContext(identity GatewayContext, secret []byte, now time.Time) (string, error) {
	if len(secret) < 32 {
		return "", errors.New("gateway context HMAC secret must contain at least 32 bytes")
	}
	deadline := time.UnixMilli(identity.AbsoluteDeadlineEpochMs)
	if !deadline.After(now) || deadline.Sub(now) > maxDeadline {
		return "", errors.New("gateway deadline must be within the next 60 seconds")
	}
	payload, err := SignaturePayload(identity)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func (client *Client) Chat(
	ctx context.Context,
	body map[string]any,
	options ChatOptions,
) (json.RawMessage, error) {
	identity, ctx, cancel, err := client.requestContext(ctx, options)
	if err != nil {
		return nil, err
	}
	defer cancel()
	requestBody := cloneMap(body)
	requestBody["stream"] = false
	response, err := client.do(ctx, http.MethodPost, "/v1/chat/completions", requestBody, identity, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return readJSONResponse(response)
}

func (client *Client) ChatStream(
	ctx context.Context,
	body map[string]any,
	options ChatOptions,
	consume func(SSEEvent) error,
) error {
	if consume == nil {
		return errors.New("SSE consumer is required")
	}
	identity, ctx, cancel, err := client.requestContext(ctx, options)
	if err != nil {
		return err
	}
	defer cancel()
	requestBody := cloneMap(body)
	requestBody["stream"] = true
	response, err := client.do(
		ctx, http.MethodPost, "/v1/chat/completions/stream",
		requestBody, identity, "text/event-stream")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return responseError(response)
	}
	return parseSSE(response.Body, consume)
}

func (client *Client) Evaluate(
	ctx context.Context,
	requestBody map[string]any,
) (json.RawMessage, error) {
	if client.guardAPIKey == "" {
		return nil, errors.New("GuardAPIKey is required for direct evaluation")
	}
	scope, ok := requestBody["context"].(map[string]any)
	if !ok || scope["tenantId"] != client.tenantID || scope["applicationId"] != client.applicationID {
		return nil, errors.New("guard request scope does not match the SDK client scope")
	}
	payload, err := json.Marshal(requestBody)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, client.endpoint("/api/v1/guard/evaluate"), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Guard-Api-Key", client.guardAPIKey)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("guard gateway request failed: %w", err)
	}
	defer response.Body.Close()
	return readJSONResponse(response)
}

func (client *Client) requestContext(
	ctx context.Context,
	options ChatOptions,
) (GatewayContext, context.Context, context.CancelFunc, error) {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = client.timeout
	}
	if timeout > maxDeadline {
		timeout = maxDeadline
	}
	requestID := options.RequestID
	if requestID == "" {
		requestID = randomID()
	}
	traceID := options.TraceID
	if traceID == "" {
		traceID = randomID()
	}
	deadline := time.Now().Add(timeout)
	identity := GatewayContext{
		TenantID:                client.tenantID,
		ApplicationID:           client.applicationID,
		PrincipalID:             options.PrincipalID,
		CredentialID:            client.credentialID,
		RequestID:               requestID,
		TraceID:                 traceID,
		SessionID:               options.SessionID,
		AbsoluteDeadlineEpochMs: deadline.UnixMilli(),
	}
	if _, err := SignGatewayContext(identity, client.secret, time.Now()); err != nil {
		return GatewayContext{}, nil, nil, err
	}
	requestContext, cancel := context.WithDeadline(ctx, deadline)
	return identity, requestContext, cancel, nil
}

func (client *Client) do(
	ctx context.Context,
	method string,
	path string,
	body map[string]any,
	identity GatewayContext,
	accept string,
) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(
		ctx, method, client.endpoint(path), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	signature, err := SignGatewayContext(identity, client.secret, time.Now())
	if err != nil {
		return nil, err
	}
	request.Header.Set("X-Tenant-Id", identity.TenantID)
	request.Header.Set("X-Application-Id", identity.ApplicationID)
	if identity.PrincipalID != "" {
		request.Header.Set("X-Principal-Id", identity.PrincipalID)
	}
	if identity.CredentialID != "" {
		request.Header.Set("X-Credential-Id", identity.CredentialID)
	}
	request.Header.Set("X-Request-Id", identity.RequestID)
	request.Header.Set("X-Trace-Id", identity.TraceID)
	if identity.SessionID != "" {
		request.Header.Set("X-Session-Id", identity.SessionID)
	}
	request.Header.Set("X-Absolute-Deadline-Epoch-Ms",
		strconv.FormatInt(identity.AbsoluteDeadlineEpochMs, 10))
	request.Header.Set("X-Guard-Context-Version", contextVersion)
	request.Header.Set("X-Guard-Context-Signature", signature)
	request.Header.Set("X-Guard-Deadline", strconv.FormatInt(identity.AbsoluteDeadlineEpochMs, 10))
	request.Header.Set("Idempotency-Key", identity.RequestID)
	if client.guardAPIKey != "" {
		request.Header.Set("X-Guard-Api-Key", client.guardAPIKey)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("guard gateway request failed: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, responseError(response)
	}
	return response, nil
}

func parseSSE(reader io.Reader, consume func(SSEEvent) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	event := SSEEvent{}
	data := make([]string, 0, 4)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(data) > 0 {
				event.Data = strings.Join(data, "\n")
				if err := consume(event); err != nil {
					return err
				}
			}
			event = SSEEvent{}
			data = data[:0]
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "event":
			event.Event = value
		case "id":
			event.ID = value
		case "data":
			data = append(data, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("guard gateway SSE read failed: %w", err)
	}
	if len(data) > 0 || event.Event != "" || event.ID != "" {
		return errors.New("guard gateway returned a truncated SSE event")
	}
	return nil
}

func readJSONResponse(response *http.Response) (json.RawMessage, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxResponse {
		return nil, errors.New("guard gateway response is too large")
	}
	if !json.Valid(payload) {
		return nil, errors.New("guard gateway returned invalid JSON")
	}
	return json.RawMessage(payload), nil
}

func responseError(response *http.Response) error {
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	return fmt.Errorf("guard gateway returned HTTP %d: %s",
		response.StatusCode, strings.TrimSpace(string(payload)))
}

func secureHTTPClient(config Config) (*http.Client, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.CAFile != "" {
		pem, err := os.ReadFile(config.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read CA file: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	if (config.ClientCertificate == "") != (config.ClientPrivateKey == "") {
		return nil, errors.New("both client certificate and private key are required for mTLS")
	}
	if config.ClientCertificate != "" {
		certificate, err := tls.LoadX509KeyPair(
			config.ClientCertificate, config.ClientPrivateKey)
		if err != nil {
			return nil, fmt.Errorf("load mTLS identity: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	transport.DialContext = (&net.Dialer{
		Timeout:   2 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext
	return &http.Client{Transport: transport}, nil
}

func (client *Client) endpoint(path string) string {
	return strings.TrimRight(client.baseURL.String(), "/") + path
}

func bounded(value string, name string, minimum int) (string, error) {
	candidate := strings.TrimSpace(value)
	if len(candidate) < minimum || len(candidate) > 128 ||
		strings.ContainsAny(candidate, "\r\n") {
		return "", fmt.Errorf("%s must contain %d..128 characters without line breaks", name, minimum)
	}
	return candidate, nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func randomID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic("operating system random source is unavailable")
	}
	return hex.EncodeToString(value)
}

func cloneMap(value map[string]any) map[string]any {
	result := make(map[string]any, len(value)+1)
	for key, item := range value {
		result[key] = item
	}
	return result
}
