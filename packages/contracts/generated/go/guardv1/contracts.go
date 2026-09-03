// Code generated from model/guard-v1.schema.json. DO NOT EDIT.
// Source SHA-256: 95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf
package guardv1

const GuardContractVersion = "1.0"
const GuardContractSourceSHA256 = "95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf"

type Direction string

const (
	DirectionInput Direction = "INPUT"
	DirectionOutputComplete Direction = "OUTPUT_COMPLETE"
	DirectionOutputChunk Direction = "OUTPUT_CHUNK"
	DirectionRagIngest Direction = "RAG_INGEST"
	DirectionRagContext Direction = "RAG_CONTEXT"
	DirectionToolRequest Direction = "TOOL_REQUEST"
	DirectionToolResult Direction = "TOOL_RESULT"
)

type GuardAction string

const (
	GuardActionAllow GuardAction = "ALLOW"
	GuardActionWarn GuardAction = "WARN"
	GuardActionBlock GuardAction = "BLOCK"
	GuardActionMask GuardAction = "MASK"
	GuardActionRewrite GuardAction = "REWRITE"
	GuardActionSafeResponse GuardAction = "SAFE_RESPONSE"
	GuardActionRequireReview GuardAction = "REQUIRE_REVIEW"
)

type RiskLevel string

const (
	RiskLevelNone RiskLevel = "NONE"
	RiskLevelLow RiskLevel = "LOW"
	RiskLevelMedium RiskLevel = "MEDIUM"
	RiskLevelHigh RiskLevel = "HIGH"
	RiskLevelCritical RiskLevel = "CRITICAL"
)

type ObservationStatus string

const (
	ObservationStatusMatch ObservationStatus = "MATCH"
	ObservationStatusNoMatch ObservationStatus = "NO_MATCH"
	ObservationStatusTimeout ObservationStatus = "TIMEOUT"
	ObservationStatusError ObservationStatus = "ERROR"
	ObservationStatusSkipped ObservationStatus = "SKIPPED"
)

type ArtifactKind string

const (
	ArtifactKindText ArtifactKind = "TEXT"
	ArtifactKindImage ArtifactKind = "IMAGE"
	ArtifactKindAudio ArtifactKind = "AUDIO"
	ArtifactKindVideo ArtifactKind = "VIDEO"
	ArtifactKindDocument ArtifactKind = "DOCUMENT"
	ArtifactKindToolResult ArtifactKind = "TOOL_RESULT"
	ArtifactKindRagChunk ArtifactKind = "RAG_CHUNK"
)

type SourceType string

const (
	SourceTypeSystem SourceType = "SYSTEM"
	SourceTypeUser SourceType = "USER"
	SourceTypeRag SourceType = "RAG"
	SourceTypeTool SourceType = "TOOL"
	SourceTypeMemory SourceType = "MEMORY"
	SourceTypeAgent SourceType = "AGENT"
	SourceTypeFile SourceType = "FILE"
	SourceTypeMedia SourceType = "MEDIA"
)

type TrustLevel string

const (
	TrustLevelTrusted TrustLevel = "TRUSTED"
	TrustLevelControlled TrustLevel = "CONTROLLED"
	TrustLevelUntrusted TrustLevel = "UNTRUSTED"
)

type InstructionCapability string

const (
	InstructionCapabilityAllowed InstructionCapability = "ALLOWED"
	InstructionCapabilityDataOnly InstructionCapability = "DATA_ONLY"
	InstructionCapabilityForbidden InstructionCapability = "FORBIDDEN"
)

type GuardFailMode string

const (
	GuardFailModeNormal GuardFailMode = "NORMAL"
	GuardFailModeFailClosed GuardFailMode = "FAIL_CLOSED"
	GuardFailModeDegraded GuardFailMode = "DEGRADED"
	GuardFailModeFailOpen GuardFailMode = "FAIL_OPEN"
)

type ProcessingStage string

const (
	ProcessingStageInputPre ProcessingStage = "INPUT_PRE"
	ProcessingStageModelPre ProcessingStage = "MODEL_PRE"
	ProcessingStageModelStream ProcessingStage = "MODEL_STREAM"
	ProcessingStageOutputPost ProcessingStage = "OUTPUT_POST"
	ProcessingStageRagIngest ProcessingStage = "RAG_INGEST"
	ProcessingStageRagRetrieve ProcessingStage = "RAG_RETRIEVE"
	ProcessingStageToolPre ProcessingStage = "TOOL_PRE"
	ProcessingStageToolPost ProcessingStage = "TOOL_POST"
	ProcessingStageMediaAnalyze ProcessingStage = "MEDIA_ANALYZE"
	ProcessingStageOfflineEvaluate ProcessingStage = "OFFLINE_EVALUATE"
)

type SideEffect string

const (
	SideEffectNone SideEffect = "NONE"
	SideEffectRead SideEffect = "READ"
	SideEffectWrite SideEffect = "WRITE"
	SideEffectExecute SideEffect = "EXECUTE"
	SideEffectExternalCommunication SideEffect = "EXTERNAL_COMMUNICATION"
	SideEffectFinancial SideEffect = "FINANCIAL"
	SideEffectPrivilegeChange SideEffect = "PRIVILEGE_CHANGE"
)

type ContextEnvelope struct {
	EnvelopeId string `json:"envelopeId"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	SessionId *string `json:"sessionId,omitempty"`
	SourceType SourceType `json:"sourceType"`
	SourceId string `json:"sourceId"`
	TrustLevel TrustLevel `json:"trustLevel"`
	InstructionCapability InstructionCapability `json:"instructionCapability"`
	SensitivityLabels []string `json:"sensitivityLabels"`
	ContentHash string `json:"contentHash"`
	ParentEnvelopeIds []string `json:"parentEnvelopeIds"`
	PolicyVersion string `json:"policyVersion"`
	EventSeq int64 `json:"eventSeq"`
	ContentStart int64 `json:"contentStart"`
	ContentEnd int64 `json:"contentEnd"`
	ExpiresAtEpochMs *int64 `json:"expiresAtEpochMs,omitempty"`
	Signature *string `json:"signature,omitempty"`
	SignatureKeyId *string `json:"signatureKeyId,omitempty"`
}

type ActionIntent struct {
	IntentId string `json:"intentId"`
	UserGoal string `json:"userGoal"`
	ToolName string `json:"toolName"`
	ParametersDigest string `json:"parametersDigest"`
	TargetResource string `json:"targetResource"`
	SideEffect SideEffect `json:"sideEffect"`
	RequiredPermissions []string `json:"requiredPermissions"`
	SupportingEnvelopeIds []string `json:"supportingEnvelopeIds"`
	DataDestinations []string `json:"dataDestinations"`
	RiskBudget float64 `json:"riskBudget"`
	ExpiresAtEpochMs *int64 `json:"expiresAtEpochMs,omitempty"`
}

type RequestContext struct {
	TraceId string `json:"traceId"`
	RequestId string `json:"requestId"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	SessionId *string `json:"sessionId,omitempty"`
	Direction Direction `json:"direction"`
	AbsoluteDeadlineEpochMs int64 `json:"absoluteDeadlineEpochMs"`
	PolicyBundleId string `json:"policyBundleId"`
	SubjectId *string `json:"subjectId,omitempty"`
	AuthContextId *string `json:"authContextId,omitempty"`
	TokenizerId *string `json:"tokenizerId,omitempty"`
	Stage *ProcessingStage `json:"stage,omitempty"`
}

type ArtifactRef struct {
	ArtifactId string `json:"artifactId"`
	Kind ArtifactKind `json:"kind"`
	MediaType string `json:"mediaType"`
	SizeBytes int64 `json:"sizeBytes"`
	Sha256 string `json:"sha256"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type GuardContent struct {
	Text *string `json:"text,omitempty"`
	Artifacts []ArtifactRef `json:"artifacts,omitempty"`
	Envelopes []ContextEnvelope `json:"envelopes,omitempty"`
}

type GuardRequest struct {
	ContractVersion string `json:"contractVersion"`
	Context RequestContext `json:"context"`
	Content GuardContent `json:"content"`
	ActionIntent *ActionIntent `json:"actionIntent,omitempty"`
}

type EvidenceRef struct {
	ViewId string `json:"viewId"`
	Start *int64 `json:"start,omitempty"`
	End *int64 `json:"end,omitempty"`
	ArtifactId *string `json:"artifactId,omitempty"`
	Region []float64 `json:"region,omitempty"`
	TimeRangeMs []int64 `json:"timeRangeMs,omitempty"`
	MaskedPreview *string `json:"maskedPreview,omitempty"`
	ContentHmac string `json:"contentHmac"`
	SourceEnvelopeIds []string `json:"sourceEnvelopeIds,omitempty"`
	TokenStart *int64 `json:"tokenStart,omitempty"`
	TokenEnd *int64 `json:"tokenEnd,omitempty"`
	TokenizerId *string `json:"tokenizerId,omitempty"`
}

type Observation struct {
	DetectorId string `json:"detectorId"`
	DetectorVersion string `json:"detectorVersion"`
	RiskType string `json:"riskType"`
	Score float64 `json:"score"`
	Severity RiskLevel `json:"severity"`
	Evidence []EvidenceRef `json:"evidence"`
	Status ObservationStatus `json:"status"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	ModelVersion *string `json:"modelVersion,omitempty"`
	ConfigurationDigest *string `json:"configurationDigest,omitempty"`
	FailMode *GuardFailMode `json:"failMode,omitempty"`
}

type GuardDecision struct {
	ContractVersion string `json:"contractVersion"`
	DecisionId string `json:"decisionId"`
	TraceId string `json:"traceId"`
	Action GuardAction `json:"action"`
	RiskLevel RiskLevel `json:"riskLevel"`
	Observations []Observation `json:"observations"`
	PolicyPath []string `json:"policyPath"`
	BundleId string `json:"bundleId"`
	LatencyMs int64 `json:"latencyMs"`
	DegradationReasons []string `json:"degradationReasons"`
	TransformedText *string `json:"transformedText,omitempty"`
	ModelVersions []string `json:"modelVersions,omitempty"`
	FailMode *GuardFailMode `json:"failMode,omitempty"`
	EvidenceComplete *bool `json:"evidenceComplete,omitempty"`
}

type GuardError struct {
	ContractVersion string `json:"contractVersion"`
	Code string `json:"code"`
	Message string `json:"message"`
	TraceId string `json:"traceId"`
	Retryable bool `json:"retryable"`
	Details map[string]any `json:"details,omitempty"`
}

type GuardEvent struct {
	ContractVersion string `json:"contractVersion"`
	EventId string `json:"eventId"`
	EventType string `json:"eventType"`
	OccurredAt string `json:"occurredAt"`
	TraceId string `json:"traceId"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	Payload any `json:"payload"`
	SequenceNumber *int64 `json:"sequenceNumber,omitempty"`
	ExpiresAtEpochMs *int64 `json:"expiresAtEpochMs,omitempty"`
	Signature *string `json:"signature,omitempty"`
	SignatureKeyId *string `json:"signatureKeyId,omitempty"`
}
