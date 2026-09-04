// Code generated from model/guard-v1.schema.json. DO NOT EDIT.
// Source SHA-256: 5e535f81fcd1a87d610f5e1876c5bff2db310e6e050872e15995b940fdbe4776
package guardv1

const GuardContractVersion = "1.0"
const GuardContractSourceSHA256 = "5e535f81fcd1a87d610f5e1876c5bff2db310e6e050872e15995b940fdbe4776"

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

type ContextRole string

const (
	ContextRoleMention ContextRole = "mention"
	ContextRoleQuotation ContextRole = "quotation"
	ContextRoleNews ContextRole = "news"
	ContextRoleLegal ContextRole = "legal"
	ContextRoleResearch ContextRole = "research"
	ContextRoleEducation ContextRole = "education"
	ContextRoleMedical ContextRole = "medical"
	ContextRoleInstruction ContextRole = "instruction"
	ContextRoleTransaction ContextRole = "transaction"
	ContextRoleEndorsement ContextRole = "endorsement"
	ContextRoleDisclosure ContextRole = "disclosure"
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
	Modality *ArtifactKind `json:"modality,omitempty"`
	ArtifactId *string `json:"artifactId,omitempty"`
	Page *int64 `json:"page,omitempty"`
	TimeRangeMs []int64 `json:"timeRangeMs,omitempty"`
	Region []float64 `json:"region,omitempty"`
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
	SourceType *SourceType `json:"sourceType,omitempty"`
	Locale *string `json:"locale,omitempty"`
	Jurisdiction *string `json:"jurisdiction,omitempty"`
	Industry *string `json:"industry,omitempty"`
	Direction Direction `json:"direction"`
	AbsoluteDeadlineEpochMs int64 `json:"absoluteDeadlineEpochMs"`
	PolicyBundleId string `json:"policyBundleId"`
	SubjectId *string `json:"subjectId,omitempty"`
	AuthContextId *string `json:"authContextId,omitempty"`
	TokenizerId *string `json:"tokenizerId,omitempty"`
	Stage *ProcessingStage `json:"stage,omitempty"`
	BusinessLine *string `json:"businessLine,omitempty"`
	LegalDisclaimerVersion *string `json:"legalDisclaimerVersion,omitempty"`
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
	NormalizedStart *int64 `json:"normalizedStart,omitempty"`
	NormalizedEnd *int64 `json:"normalizedEnd,omitempty"`
	NormalizationTransforms []string `json:"normalizationTransforms,omitempty"`
}

type Observation struct {
	DetectorId string `json:"detectorId"`
	DetectorVersion string `json:"detectorVersion"`
	RiskType string `json:"riskType"`
	Category *string `json:"category,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
	RuleId *string `json:"ruleId,omitempty"`
	RuleVersion *string `json:"ruleVersion,omitempty"`
	DictionaryReleaseId *string `json:"dictionaryReleaseId,omitempty"`
	DictionaryVersion *string `json:"dictionaryVersion,omitempty"`
	Score float64 `json:"score"`
	Severity RiskLevel `json:"severity"`
	Evidence []EvidenceRef `json:"evidence"`
	Status ObservationStatus `json:"status"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	ModelVersion *string `json:"modelVersion,omitempty"`
	ConfigurationDigest *string `json:"configurationDigest,omitempty"`
	FailMode *GuardFailMode `json:"failMode,omitempty"`
	CanonicalTermId *string `json:"canonicalTermId,omitempty"`
	VariantId *string `json:"variantId,omitempty"`
	DictionaryLayer *string `json:"dictionaryLayer,omitempty"`
	ContextRole *ContextRole `json:"contextRole,omitempty"`
}

type LatencyBreakdown struct {
	NormalizationMs *int64 `json:"normalizationMs,omitempty"`
	DetectionMs *int64 `json:"detectionMs,omitempty"`
	AggregationMs *int64 `json:"aggregationMs,omitempty"`
	InterventionMs *int64 `json:"interventionMs,omitempty"`
	TotalMs int64 `json:"totalMs"`
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
	LatencyBreakdown *LatencyBreakdown `json:"latencyBreakdown,omitempty"`
	Degraded *bool `json:"degraded,omitempty"`
	ReasonCodes []string `json:"reasonCodes,omitempty"`
	DegradationReasons []string `json:"degradationReasons"`
	TransformedText *string `json:"transformedText,omitempty"`
	ModelVersions []string `json:"modelVersions,omitempty"`
	FailMode *GuardFailMode `json:"failMode,omitempty"`
	EvidenceComplete *bool `json:"evidenceComplete,omitempty"`
	Score *float64 `json:"score,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
	Compliance *ComplianceContext `json:"compliance,omitempty"`
	Transform *DecisionTransform `json:"transform,omitempty"`
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

type DlpTransformOperation string

const (
	DlpTransformOperationPartialMask DlpTransformOperation = "PARTIAL_MASK"
	DlpTransformOperationFullMask DlpTransformOperation = "FULL_MASK"
	DlpTransformOperationTokenize DlpTransformOperation = "TOKENIZE"
	DlpTransformOperationRedact DlpTransformOperation = "REDACT"
	DlpTransformOperationBlock DlpTransformOperation = "BLOCK"
)

type DecisionTransformType string

const (
	DecisionTransformTypeMask DecisionTransformType = "MASK"
	DecisionTransformTypeRewrite DecisionTransformType = "REWRITE"
	DecisionTransformTypeSafeResponse DecisionTransformType = "SAFE_RESPONSE"
	DecisionTransformTypeRequireReview DecisionTransformType = "REQUIRE_REVIEW"
	DecisionTransformTypeBlock DecisionTransformType = "BLOCK"
)

type DecisionTransformRange struct {
	EntityType string `json:"entityType"`
	Operation DlpTransformOperation `json:"operation"`
	Start int64 `json:"start"`
	End int64 `json:"end"`
	OutputStart int64 `json:"outputStart"`
	OutputEnd int64 `json:"outputEnd"`
	MaskedPreview string `json:"maskedPreview"`
	ContentHmac string `json:"contentHmac"`
}

type DecisionTransform struct {
	Type DecisionTransformType `json:"type"`
	Ranges []DecisionTransformRange `json:"ranges"`
	TemplateId *string `json:"templateId,omitempty"`
	TemplateVersion *int64 `json:"templateVersion,omitempty"`
	OutputHash string `json:"outputHash"`
	RecheckDecisionId *string `json:"recheckDecisionId,omitempty"`
}

type ComplianceContext struct {
	Locale string `json:"locale"`
	Jurisdiction string `json:"jurisdiction"`
	Industry string `json:"industry"`
	BusinessLine string `json:"businessLine"`
	PolicyVersion string `json:"policyVersion"`
	LegalDisclaimerVersion string `json:"legalDisclaimerVersion"`
}
