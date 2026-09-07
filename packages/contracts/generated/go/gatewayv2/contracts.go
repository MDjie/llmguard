// Code generated from model/gateway-v2.schema.json. DO NOT EDIT.
// Source SHA-256: 121c28d9326b01100816725fd291a43f2d45a2d698a2d3d2749ab8f83cddb810
package gatewayv2

const GuardContractVersion = "2.0"
const GuardContractSourceSHA256 = "121c28d9326b01100816725fd291a43f2d45a2d698a2d3d2749ab8f83cddb810"

type GatewayAction string

const (
	GatewayActionAllow GatewayAction = "ALLOW"
	GatewayActionWarn GatewayAction = "WARN"
	GatewayActionBlock GatewayAction = "BLOCK"
	GatewayActionMask GatewayAction = "MASK"
	GatewayActionRewrite GatewayAction = "REWRITE"
	GatewayActionSafeResponse GatewayAction = "SAFE_RESPONSE"
	GatewayActionRequireReview GatewayAction = "REQUIRE_REVIEW"
)

type GatewayStage string

const (
	GatewayStageInput GatewayStage = "INPUT"
	GatewayStageInputRecheck GatewayStage = "INPUT_RECHECK"
	GatewayStageOutputComplete GatewayStage = "OUTPUT_COMPLETE"
	GatewayStageOutputChunk GatewayStage = "OUTPUT_CHUNK"
	GatewayStageOutputRecheck GatewayStage = "OUTPUT_RECHECK"
	GatewayStageToolRequest GatewayStage = "TOOL_REQUEST"
	GatewayStageToolResult GatewayStage = "TOOL_RESULT"
	GatewayStageRagContext GatewayStage = "RAG_CONTEXT"
)

type GatewayCoverage string

const (
	GatewayCoverageComplete GatewayCoverage = "COMPLETE"
	GatewayCoveragePartial GatewayCoverage = "PARTIAL"
	GatewayCoverageUnknown GatewayCoverage = "UNKNOWN"
)

type GatewayStatus string

const (
	GatewayStatusSucceeded GatewayStatus = "SUCCEEDED"
	GatewayStatusFailed GatewayStatus = "FAILED"
	GatewayStatusTimedOut GatewayStatus = "TIMED_OUT"
	GatewayStatusCancelled GatewayStatus = "CANCELLED"
)

type ExecutionKind string

const (
	ExecutionKindUpstreamSendIntent ExecutionKind = "UPSTREAM_SEND_INTENT"
	ExecutionKindUpstreamSendStarted ExecutionKind = "UPSTREAM_SEND_STARTED"
	ExecutionKindReleaseIntent ExecutionKind = "RELEASE_INTENT"
	ExecutionKindWriteAccepted ExecutionKind = "WRITE_ACCEPTED"
	ExecutionKindTerminated ExecutionKind = "TERMINATED"
	ExecutionKindCompleted ExecutionKind = "COMPLETED"
)

type SnapshotState string

const (
	SnapshotStatePrepared SnapshotState = "PREPARED"
	SnapshotStateLoaded SnapshotState = "LOADED"
	SnapshotStateCanary SnapshotState = "CANARY"
	SnapshotStateActive SnapshotState = "ACTIVE"
	SnapshotStateRevoked SnapshotState = "REVOKED"
)

type PolicyRef struct {
	SnapshotId string `json:"snapshotId"`
	BundleId string `json:"bundleId"`
	Generation int64 `json:"generation"`
	Digest string `json:"digest"`
}

type GatewayBudgets struct {
	MaxInputChars int64 `json:"maxInputChars"`
	MaxOutputChars int64 `json:"maxOutputChars"`
	MaxSteps int64 `json:"maxSteps"`
	MaxEvents int64 `json:"maxEvents"`
	MaxStreamEvents int64 `json:"maxStreamEvents"`
	IdleTimeoutMs int64 `json:"idleTimeoutMs"`
	AbsoluteTimeoutMs int64 `json:"absoluteTimeoutMs"`
}

type ModelRoutingRecord struct {
	ConfigurationJson string `json:"configurationJson"`
	ConfigurationDigest string `json:"configurationDigest"`
}

type WindowPolicy struct {
	ConfigurationDigest string `json:"configurationDigest"`
	QualificationId string `json:"qualificationId"`
	QualificationExpiresAt int64 `json:"qualificationExpiresAt"`
	ContextChars int64 `json:"contextChars"`
	ChunkChars int64 `json:"chunkChars"`
	HoldbackChars int64 `json:"holdbackChars"`
}

type RuntimeManifest struct {
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	Generation int64 `json:"generation"`
	BundleId string `json:"bundleId"`
	BundleDigest string `json:"bundleDigest"`
	ModelRoutes []string `json:"modelRoutes"`
	DataBoundary string `json:"dataBoundary"`
	StreamMode string `json:"streamMode"`
	WindowQualified bool `json:"windowQualified"`
	HoldbackChars int64 `json:"holdbackChars"`
	Budgets GatewayBudgets `json:"budgets"`
	ValidUntil int64 `json:"validUntil"`
	NormalizationVersion string `json:"normalizationVersion"`
	ModelRouting *ModelRoutingRecord `json:"modelRouting,omitempty"`
	WindowPolicy *WindowPolicy `json:"windowPolicy,omitempty"`
}

type RuntimeSnapshot struct {
	Id string `json:"id"`
	Manifest RuntimeManifest `json:"manifest"`
	Digest string `json:"digest"`
	Signature string `json:"signature"`
	KeyId string `json:"keyId"`
	State SnapshotState `json:"state"`
}

type AuthContext struct {
	ContractVersion string `json:"contractVersion"`
	AuthContextId string `json:"authContextId"`
	Issuer string `json:"issuer"`
	Audience string `json:"audience"`
	KeyId string `json:"keyId"`
	IssuedAt int64 `json:"issuedAt"`
	ExpiresAt int64 `json:"expiresAt"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	SubjectId string `json:"subjectId"`
	CredentialId *string `json:"credentialId,omitempty"`
	AuthVersion int64 `json:"authVersion"`
	BusinessRequestId string `json:"businessRequestId"`
	TraceId string `json:"traceId"`
	SessionId *string `json:"sessionId,omitempty"`
	RequestDigest string `json:"requestDigest"`
	Policy PolicyRef `json:"policy"`
	AllowedModelRoutes []string `json:"allowedModelRoutes"`
	Permissions []string `json:"permissions"`
	DataBoundary string `json:"dataBoundary"`
	Deadline int64 `json:"deadline"`
	SubjectVersion *int64 `json:"subjectVersion,omitempty"`
	PreparedRequestDigest *string `json:"preparedRequestDigest,omitempty"`
	InputSegmentsDigest *string `json:"inputSegmentsDigest,omitempty"`
}

type SignedAuthContext struct {
	Context AuthContext `json:"context"`
	Signature string `json:"signature"`
}

type ContentSegment struct {
	SegmentId string `json:"segmentId"`
	ContentPath string `json:"contentPath"`
	Role string `json:"role"`
	Text string `json:"text"`
	SourceType string `json:"sourceType"`
	SourceDigest string `json:"sourceDigest"`
}

type TransformPatch struct {
	SegmentId string `json:"segmentId"`
	ContentPath string `json:"contentPath"`
	Start int64 `json:"start"`
	End int64 `json:"end"`
	Replacement string `json:"replacement"`
	SourceDigest string `json:"sourceDigest"`
}

type WindowInspection struct {
	ContextStart int64 `json:"contextStart"`
	ReleaseStart int64 `json:"releaseStart"`
	ReleaseEnd int64 `json:"releaseEnd"`
	Final bool `json:"final"`
}

type GatewayRequest struct {
	ContractVersion string `json:"contractVersion"`
	Auth SignedAuthContext `json:"auth"`
	BusinessRequestId string `json:"businessRequestId"`
	StepId string `json:"stepId"`
	TraceId string `json:"traceId"`
	Stage GatewayStage `json:"stage"`
	StreamSeq int64 `json:"streamSeq"`
	AttemptKind string `json:"attemptKind"`
	SnapshotId string `json:"snapshotId"`
	Deadline int64 `json:"deadline"`
	Segments []ContentSegment `json:"segments"`
	Window *WindowInspection `json:"window,omitempty"`
}

type GatewayDecision struct {
	ContractVersion string `json:"contractVersion"`
	BusinessRequestId string `json:"businessRequestId"`
	StepId string `json:"stepId"`
	DecisionId string `json:"decisionId"`
	SnapshotId string `json:"snapshotId"`
	Action GatewayAction `json:"action"`
	Coverage GatewayCoverage `json:"coverage"`
	Status GatewayStatus `json:"status"`
	RiskLevel string `json:"riskLevel"`
	ReasonCodes []string `json:"reasonCodes"`
	ModelVersions []string `json:"modelVersions"`
	TransformPatches []TransformPatch `json:"transformPatches"`
	SafeResponse *string `json:"safeResponse,omitempty"`
	LatencyMs int64 `json:"latencyMs"`
}

type GatewayAuthorize struct {
	ContractVersion string `json:"contractVersion"`
	BusinessRequestId string `json:"businessRequestId"`
	TraceId string `json:"traceId"`
	SessionId *string `json:"sessionId,omitempty"`
	IdempotencyKey string `json:"idempotencyKey"`
	Deadline int64 `json:"deadline"`
	ModelRoute string `json:"modelRoute"`
	RequestDigest string `json:"requestDigest"`
	RequestJson string `json:"requestJson"`
	UserAssertion *string `json:"userAssertion,omitempty"`
}

type GatewayAuthorization struct {
	Auth SignedAuthContext `json:"auth"`
	Snapshot RuntimeSnapshot `json:"snapshot"`
	ReplayState string `json:"replayState"`
	PreparedRequestJson *string `json:"preparedRequestJson,omitempty"`
	InputSegments []ContentSegment `json:"inputSegments,omitempty"`
}

type ExecutionEvent struct {
	EventSeq int64 `json:"eventSeq"`
	StepId *string `json:"stepId,omitempty"`
	DecisionId *string `json:"decisionId,omitempty"`
	RecheckDecisionId *string `json:"recheckDecisionId,omitempty"`
	Kind ExecutionKind `json:"kind"`
	RangeStart *int64 `json:"rangeStart,omitempty"`
	RangeEnd *int64 `json:"rangeEnd,omitempty"`
	PayloadDigest *string `json:"payloadDigest,omitempty"`
	ActualAction *GatewayAction `json:"actualAction,omitempty"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	SnapshotId string `json:"snapshotId"`
}

type GatewayEvents struct {
	ContractVersion string `json:"contractVersion"`
	Auth SignedAuthContext `json:"auth"`
	Events []ExecutionEvent `json:"events"`
	TerminalReconciliation *bool `json:"terminalReconciliation,omitempty"`
}

type GatewayNodeAck struct {
	ContractVersion string `json:"contractVersion"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	SnapshotId string `json:"snapshotId"`
	NodeId string `json:"nodeId"`
	Digest string `json:"digest"`
	State string `json:"state"`
	ReasonCode *string `json:"reasonCode,omitempty"`
}

type GatewayError struct {
	ContractVersion string `json:"contractVersion"`
	Code string `json:"code"`
	RequestId string `json:"requestId"`
	TraceId string `json:"traceId"`
	Retryable bool `json:"retryable"`
}
