// Code generated from model/appliance-v1.schema.json. DO NOT EDIT.
// Source SHA-256: b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080
package appliancev1

const ApplianceContractVersion = "1.0"
const ApplianceContractSourceSHA256 = "b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080"

type TransportProtocol string

const (
	TransportProtocolTcp TransportProtocol = "TCP"
	TransportProtocolUdp TransportProtocol = "UDP"
)

type ApplicationProtocol string

const (
	ApplicationProtocolUnknown ApplicationProtocol = "UNKNOWN"
	ApplicationProtocolTls ApplicationProtocol = "TLS"
	ApplicationProtocolHttp11 ApplicationProtocol = "HTTP_1_1"
	ApplicationProtocolHttp2 ApplicationProtocol = "HTTP_2"
	ApplicationProtocolHttps ApplicationProtocol = "HTTPS"
	ApplicationProtocolSse ApplicationProtocol = "SSE"
	ApplicationProtocolWebsocket ApplicationProtocol = "WEBSOCKET"
	ApplicationProtocolGrpc ApplicationProtocol = "GRPC"
	ApplicationProtocolOpenaiApi ApplicationProtocol = "OPENAI_API"
	ApplicationProtocolMqtt ApplicationProtocol = "MQTT"
	ApplicationProtocolMcp ApplicationProtocol = "MCP"
)

type TrafficDirection string

const (
	TrafficDirectionClientToServer TrafficDirection = "CLIENT_TO_SERVER"
	TrafficDirectionServerToClient TrafficDirection = "SERVER_TO_CLIENT"
)

type ProtocolStage string

const (
	ProtocolStageFlowMetadata ProtocolStage = "FLOW_METADATA"
	ProtocolStageTlsHandshake ProtocolStage = "TLS_HANDSHAKE"
	ProtocolStageHeaders ProtocolStage = "HEADERS"
	ProtocolStageMessage ProtocolStage = "MESSAGE"
	ProtocolStageArtifact ProtocolStage = "ARTIFACT"
	ProtocolStageTrailers ProtocolStage = "TRAILERS"
)

type DeploymentMode string

const (
	DeploymentModeReverseProxy DeploymentMode = "REVERSE_PROXY"
	DeploymentModeTransparentInline DeploymentMode = "TRANSPARENT_INLINE"
	DeploymentModeTapMirror DeploymentMode = "TAP_MIRROR"
	DeploymentModeHaPair DeploymentMode = "HA_PAIR"
)

type AdmissionAction string

const (
	AdmissionActionInspect AdmissionAction = "INSPECT"
	AdmissionActionAllowMetadataOnly AdmissionAction = "ALLOW_METADATA_ONLY"
	AdmissionActionBlock AdmissionAction = "BLOCK"
	AdmissionActionMirrorOnly AdmissionAction = "MIRROR_ONLY"
)

type EnforcementAction string

const (
	EnforcementActionAllow EnforcementAction = "ALLOW"
	EnforcementActionBlock EnforcementAction = "BLOCK"
	EnforcementActionReset EnforcementAction = "RESET"
	EnforcementActionRateLimit EnforcementAction = "RATE_LIMIT"
	EnforcementActionRedirect EnforcementAction = "REDIRECT"
	EnforcementActionMask EnforcementAction = "MASK"
	EnforcementActionRewrite EnforcementAction = "REWRITE"
	EnforcementActionQuarantine EnforcementAction = "QUARANTINE"
	EnforcementActionMirrorOnly EnforcementAction = "MIRROR_ONLY"
)

type HealthAction string

const (
	HealthActionHealthy HealthAction = "HEALTHY"
	HealthActionDegrade HealthAction = "DEGRADE"
	HealthActionDrain HealthAction = "DRAIN"
	HealthActionIsolate HealthAction = "ISOLATE"
	HealthActionFailover HealthAction = "FAILOVER"
)

type ReceiptStatus string

const (
	ReceiptStatusApplied ReceiptStatus = "APPLIED"
	ReceiptStatusRejected ReceiptStatus = "REJECTED"
	ReceiptStatusExpired ReceiptStatus = "EXPIRED"
	ReceiptStatusDuplicate ReceiptStatus = "DUPLICATE"
)

type BundleActivationStatus string

const (
	BundleActivationStatusPrepared BundleActivationStatus = "PREPARED"
	BundleActivationStatusActive BundleActivationStatus = "ACTIVE"
	BundleActivationStatusRejected BundleActivationStatus = "REJECTED"
	BundleActivationStatusRolledBack BundleActivationStatus = "ROLLED_BACK"
)

type EngineType string

const (
	EngineTypeFastPath EngineType = "FAST_PATH"
	EngineTypeProtocolProxy EngineType = "PROTOCOL_PROXY"
	EngineTypeIps EngineType = "IPS"
	EngineTypeAntivirus EngineType = "ANTIVIRUS"
	EngineTypeDos EngineType = "DOS"
	EngineTypeDlp EngineType = "DLP"
	EngineTypeAiGuard EngineType = "AI_GUARD"
	EngineTypeFileAnalyzer EngineType = "FILE_ANALYZER"
	EngineTypeHardwareAgent EngineType = "HARDWARE_AGENT"
)

type NetworkEndpoint struct {
	Ip string `json:"ip"`
	Port int64 `json:"port"`
	Mac *string `json:"mac,omitempty"`
	Zone *string `json:"zone,omitempty"`
}

type TlsContext struct {
	Intercepted bool `json:"intercepted"`
	Version string `json:"version"`
	ServerName string `json:"serverName"`
	Alpn *string `json:"alpn,omitempty"`
	CipherSuite *string `json:"cipherSuite,omitempty"`
	PeerCertificateSha256 string `json:"peerCertificateSha256"`
	ClientCertificateSha256 *string `json:"clientCertificateSha256,omitempty"`
}

type FlowEnvelope struct {
	ContractVersion string `json:"contractVersion"`
	DeviceId string `json:"deviceId"`
	DeviceGroupId string `json:"deviceGroupId"`
	FlowId string `json:"flowId"`
	FlowSeq int64 `json:"flowSeq"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	SessionId *string `json:"sessionId,omitempty"`
	DeploymentMode DeploymentMode `json:"deploymentMode"`
	IngressInterface string `json:"ingressInterface"`
	EgressInterface string `json:"egressInterface"`
	VlanId *int64 `json:"vlanId,omitempty"`
	Source NetworkEndpoint `json:"source"`
	Destination NetworkEndpoint `json:"destination"`
	Transport TransportProtocol `json:"transport"`
	ApplicationProtocol ApplicationProtocol `json:"applicationProtocol"`
	Direction TrafficDirection `json:"direction"`
	ProtectedTraffic bool `json:"protectedTraffic"`
	OpenedAtEpochMs int64 `json:"openedAtEpochMs"`
	AbsoluteDeadlineEpochMs int64 `json:"absoluteDeadlineEpochMs"`
	PolicyBundleId string `json:"policyBundleId"`
	Tls *TlsContext `json:"tls,omitempty"`
}

type FlowAdmission struct {
	FlowId string `json:"flowId"`
	FlowSeq int64 `json:"flowSeq"`
	Action AdmissionAction `json:"action"`
	ReasonCode string `json:"reasonCode"`
	PolicyBundleId string `json:"policyBundleId"`
	ExpiresAtEpochMs int64 `json:"expiresAtEpochMs"`
}

type ContentReference struct {
	Uri string `json:"uri"`
	Sha256 string `json:"sha256"`
	AuthorizationId *string `json:"authorizationId,omitempty"`
	ExpiresAtEpochMs int64 `json:"expiresAtEpochMs"`
}

type FrameEnvelope struct {
	ContractVersion string `json:"contractVersion"`
	FlowId string `json:"flowId"`
	FrameId string `json:"frameId"`
	FlowSeq int64 `json:"flowSeq"`
	FrameSeq int64 `json:"frameSeq"`
	Direction TrafficDirection `json:"direction"`
	ApplicationProtocol ApplicationProtocol `json:"applicationProtocol"`
	ProtocolStage ProtocolStage `json:"protocolStage"`
	MediaType string `json:"mediaType"`
	ContentEncoding *string `json:"contentEncoding,omitempty"`
	SizeBytes int64 `json:"sizeBytes"`
	Sha256 string `json:"sha256"`
	StreamOffsetStart int64 `json:"streamOffsetStart"`
	StreamOffsetEnd int64 `json:"streamOffsetEnd"`
	AbsoluteDeadlineEpochMs int64 `json:"absoluteDeadlineEpochMs"`
	PolicyBundleId string `json:"policyBundleId"`
	InlinePayloadBase64 *string `json:"inlinePayloadBase64,omitempty"`
	ContentReference *ContentReference `json:"contentReference,omitempty"`
}

type NetworkObservation struct {
	EngineId string `json:"engineId"`
	EngineType EngineType `json:"engineType"`
	EngineVersion string `json:"engineVersion"`
	RuleVersion string `json:"ruleVersion"`
	Status string `json:"status"`
	RiskType string `json:"riskType"`
	Severity string `json:"severity"`
	Score float64 `json:"score"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	EvidenceDigest string `json:"evidenceDigest"`
	MaskedPreview *string `json:"maskedPreview,omitempty"`
}

type EnforcementDecision struct {
	ContractVersion string `json:"contractVersion"`
	DecisionId string `json:"decisionId"`
	FlowId string `json:"flowId"`
	FrameId string `json:"frameId"`
	FlowSeq int64 `json:"flowSeq"`
	FrameSeq int64 `json:"frameSeq"`
	ContentSha256 string `json:"contentSha256"`
	Action EnforcementAction `json:"action"`
	Terminal bool `json:"terminal"`
	ReasonCode string `json:"reasonCode"`
	PolicyBundleId string `json:"policyBundleId"`
	GuardDecisionId *string `json:"guardDecisionId,omitempty"`
	Observations []NetworkObservation `json:"observations"`
	IssuedAtEpochMs int64 `json:"issuedAtEpochMs"`
	ExpiresAtEpochMs int64 `json:"expiresAtEpochMs"`
	EvidenceComplete bool `json:"evidenceComplete"`
	TransformedPayloadBase64 *string `json:"transformedPayloadBase64,omitempty"`
	EnforcementToken string `json:"enforcementToken"`
}

type EnforcementReceipt struct {
	ReceiptId string `json:"receiptId"`
	DecisionId string `json:"decisionId"`
	DeviceId string `json:"deviceId"`
	FlowId string `json:"flowId"`
	FrameId string `json:"frameId"`
	Action EnforcementAction `json:"action"`
	Status ReceiptStatus `json:"status"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	ExecutedAtEpochMs int64 `json:"executedAtEpochMs"`
	BytesForwardedBeforeDecision int64 `json:"bytesForwardedBeforeDecision"`
	ReceiptDigest string `json:"receiptDigest"`
}

type ArtifactEnvelope struct {
	ContractVersion string `json:"contractVersion"`
	FlowId string `json:"flowId"`
	FrameId string `json:"frameId"`
	ArtifactId string `json:"artifactId"`
	MediaType string `json:"mediaType"`
	FileName *string `json:"fileName,omitempty"`
	SizeBytes int64 `json:"sizeBytes"`
	Sha256 string `json:"sha256"`
	ContentReference ContentReference `json:"contentReference"`
	AbsoluteDeadlineEpochMs int64 `json:"absoluteDeadlineEpochMs"`
	PolicyBundleId string `json:"policyBundleId"`
}

type FlowClose struct {
	FlowId string `json:"flowId"`
	FlowSeq int64 `json:"flowSeq"`
	ClosedAtEpochMs int64 `json:"closedAtEpochMs"`
	ReasonCode string `json:"reasonCode"`
}

type FlowReceipt struct {
	FlowId string `json:"flowId"`
	FlowSeq int64 `json:"flowSeq"`
	Status ReceiptStatus `json:"status"`
	ClosedAtEpochMs int64 `json:"closedAtEpochMs"`
	ReceiptDigest string `json:"receiptDigest"`
}

type EngineCapability struct {
	EngineId string `json:"engineId"`
	EngineType EngineType `json:"engineType"`
	Version string `json:"version"`
	ArtifactSha256 string `json:"artifactSha256"`
	Protocols []ApplicationProtocol `json:"protocols"`
	Actions []EnforcementAction `json:"actions"`
}

type HardwareCapability struct {
	CpuArchitecture string `json:"cpuArchitecture"`
	CpuModel string `json:"cpuModel"`
	MemoryBytes int64 `json:"memoryBytes"`
	NicModels []string `json:"nicModels"`
	AcceleratorModels []string `json:"acceleratorModels"`
	DriverDigests []string `json:"driverDigests"`
	FirmwareDigests []string `json:"firmwareDigests"`
	PhysicalBypassAvailable bool `json:"physicalBypassAvailable"`
	TrustedKeyDeviceAvailable bool `json:"trustedKeyDeviceAvailable"`
}

type CapabilityManifest struct {
	ContractVersion string `json:"contractVersion"`
	DeviceId string `json:"deviceId"`
	DeviceGroupId string `json:"deviceGroupId"`
	Generation int64 `json:"generation"`
	ReportedAtEpochMs int64 `json:"reportedAtEpochMs"`
	SoftwareVersion string `json:"softwareVersion"`
	SoftwareDigest string `json:"softwareDigest"`
	DeploymentModes []DeploymentMode `json:"deploymentModes"`
	Engines []EngineCapability `json:"engines"`
	Hardware HardwareCapability `json:"hardware"`
	ManifestDigest string `json:"manifestDigest"`
}

type HealthComponent struct {
	ComponentId string `json:"componentId"`
	Action HealthAction `json:"action"`
	ReasonCodes []string `json:"reasonCodes"`
	Utilization *float64 `json:"utilization,omitempty"`
	QueueDepth *int64 `json:"queueDepth,omitempty"`
	TemperatureCelsius *float64 `json:"temperatureCelsius,omitempty"`
}

type HealthSnapshot struct {
	DeviceId string `json:"deviceId"`
	Generation int64 `json:"generation"`
	CapturedAtEpochMs int64 `json:"capturedAtEpochMs"`
	Action HealthAction `json:"action"`
	Components []HealthComponent `json:"components"`
	SnapshotDigest string `json:"snapshotDigest"`
}

type BundleActivationReceipt struct {
	DeviceId string `json:"deviceId"`
	BundleId string `json:"bundleId"`
	Generation int64 `json:"generation"`
	BundleDigest string `json:"bundleDigest"`
	Status BundleActivationStatus `json:"status"`
	ReasonCode *string `json:"reasonCode,omitempty"`
	ComponentDigests map[string]any `json:"componentDigests"`
	RecordedAtEpochMs int64 `json:"recordedAtEpochMs"`
	ReceiptDigest string `json:"receiptDigest"`
}

type NetworkBypassPermitPayloadV2 struct {
	Version string `json:"version"`
	PermitId string `json:"permitId"`
	DeviceGroupId string `json:"deviceGroupId"`
	TenantId string `json:"tenantId"`
	ApplicationId string `json:"applicationId"`
	PortPairs []string `json:"portPairs"`
	Protocols []ApplicationProtocol `json:"protocols"`
	MaximumConnections int64 `json:"maximumConnections"`
	MaximumBytes int64 `json:"maximumBytes"`
	Reason string `json:"reason"`
	ChangeTicketId string `json:"changeTicketId"`
	ApproverIds []string `json:"approverIds"`
	PolicyBundleId string `json:"policyBundleId"`
	IssuedAtEpochMs int64 `json:"issuedAtEpochMs"`
	ExpiresAtEpochMs int64 `json:"expiresAtEpochMs"`
}

type SignedNetworkBypassPermitV2 struct {
	KeyId string `json:"keyId"`
	Algorithm string `json:"algorithm"`
	Payload NetworkBypassPermitPayloadV2 `json:"payload"`
	Signature string `json:"signature"`
}

type CapabilityAck struct {
	DeviceId string `json:"deviceId"`
	Generation int64 `json:"generation"`
	Accepted bool `json:"accepted"`
	ReasonCode string `json:"reasonCode"`
}

type HealthAck struct {
	DeviceId string `json:"deviceId"`
	Generation int64 `json:"generation"`
	Accepted bool `json:"accepted"`
	RequiredAction HealthAction `json:"requiredAction"`
}

type BundleAck struct {
	DeviceId string `json:"deviceId"`
	BundleId string `json:"bundleId"`
	Generation int64 `json:"generation"`
	Accepted bool `json:"accepted"`
	ReasonCode string `json:"reasonCode"`
}

type ReceiptAck struct {
	ReceiptId string `json:"receiptId"`
	Accepted bool `json:"accepted"`
	ReasonCode string `json:"reasonCode"`
}
