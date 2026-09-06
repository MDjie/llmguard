import { sql } from "drizzle-orm";
import { pgTable, varchar, text, timestamp, boolean, integer, bigint, decimal, jsonb, index, uniqueIndex, serial, uuid, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";

// ============================================
// 系统表 - 必须保留，禁止删除
// ============================================
export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const tenants = pgTable(
	"tenants",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		code: varchar("code", { length: 64 }).notNull().unique(),
		name: varchar("name", { length: 200 }).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("tenants_status_idx").on(table.status),
	]
);

export const applications = pgTable(
	"applications",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		tenantId: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 64 }).notNull(),
		name: varchar("name", { length: 200 }).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("applications_tenant_code_uq").on(table.tenantId, table.code),
		index("applications_tenant_status_idx").on(table.tenantId, table.status),
	]
);

export const applicationCredentials = pgTable(
	"application_credentials",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		tenantId: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "cascade" }),
		applicationId: varchar("application_id", { length: 36 }).notNull().references(() => applications.id, { onDelete: "cascade" }),
		keyId: varchar("key_id", { length: 64 }).notNull().unique(),
		name: varchar("name", { length: 128 }).notNull(),
		secretHash: varchar("secret_hash", { length: 64 }).notNull(),
		permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("application_credentials_scope_idx").on(table.tenantId, table.applicationId),
		index("application_credentials_expires_at_idx").on(table.expiresAt),
	]
);

function tenantScopeColumns() {
	return {
		tenantId: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "restrict" }),
		applicationId: varchar("application_id", { length: 36 }).notNull().references(() => applications.id, { onDelete: "restrict" }),
	};
}

// 分布式限流桶：固定窗口共享计数（多副本部署），bucket_key 为 sha256(policyId:subject)
export const rateLimitBuckets = pgTable(
	"rate_limit_buckets",
	{
		bucketKey: varchar("bucket_key", { length: 64 }).notNull(),
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		count: integer("count").notNull().default(0),
	},
	(table) => [
		primaryKey({ columns: [table.bucketKey, table.windowStart] }),
	]
);

export const securityAuditEvents = pgTable(
	"security_audit_events",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		event: varchar("event", { length: 160 }).notNull(),
		outcome: varchar("outcome", { length: 16 }).notNull(),
		status: integer("status").notNull(),
		requestId: varchar("request_id", { length: 128 }).notNull(),
		traceId: varchar("trace_id", { length: 128 }).notNull(),
		method: varchar("method", { length: 16 }).notNull(),
		path: varchar("path", { length: 500 }).notNull(),
		queryString: varchar("query_string", { length: 1024 }),
		clientIp: varchar("client_ip", { length: 64 }),
		userAgent: varchar("user_agent", { length: 256 }),
		latencyMs: integer("latency_ms").notNull(),
		principalId: varchar("principal_id", { length: 100 }),
		tenantId: varchar("tenant_id", { length: 100 }),
		applicationId: varchar("application_id", { length: 100 }),
		partitionKey: varchar("partition_key", { length: 256 }),
		chainSequence: bigint("chain_sequence", { mode: "number" }),
		previousHash: varchar("previous_hash", { length: 64 }),
		eventHash: varchar("event_hash", { length: 64 }),
		hashKeyId: varchar("hash_key_id", { length: 64 }),
		chainVersion: integer("chain_version"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("security_audit_events_created_at_idx").on(table.createdAt),
		index("security_audit_events_principal_id_idx").on(table.principalId),
		index("security_audit_events_event_idx").on(table.event),
		uniqueIndex("security_audit_events_partition_sequence_uq").on(table.partitionKey, table.chainSequence),
	]
);

export const auditExportOutbox = pgTable(
	"audit_export_outbox",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		auditEventId: uuid("audit_event_id").notNull().references(() => securityAuditEvents.id, { onDelete: "restrict" }),
		tenantId: varchar("tenant_id", { length: 100 }),
		applicationId: varchar("application_id", { length: 100 }),
		destinationType: varchar("destination_type", { length: 16 }).notNull(),
		destination: varchar("destination", { length: 500 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		state: varchar("state", { length: 24 }).notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		lastError: varchar("last_error", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("audit_export_outbox_event_destination_uq").on(table.auditEventId, table.destinationType, table.destination),
		index("audit_export_outbox_dispatch_idx").on(table.state, table.nextAttemptAt),
		index("audit_export_outbox_scope_idx").on(table.tenantId, table.applicationId, table.createdAt),
	]
);

export const auditEvidenceTimestamps = pgTable(
	"audit_evidence_timestamps",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		auditEventId: uuid("audit_event_id").notNull()
			.references(() => securityAuditEvents.id, { onDelete: "restrict" }),
		tenantId: varchar("tenant_id", { length: 100 }),
		applicationId: varchar("application_id", { length: 100 }),
		partitionKey: varchar("partition_key", { length: 256 }).notNull(),
		chainSequence: bigint("chain_sequence", { mode: "number" }).notNull(),
		headHash: varchar("head_hash", { length: 64 }).notNull(),
		provider: varchar("provider", { length: 128 }).notNull(),
		generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
		token: text("token").notNull(),
		keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
		signature: text("signature").notNull(),
		verificationStatus: varchar("verification_status", { length: 16 }).notNull(),
		verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("audit_evidence_timestamps_event_uq").on(table.auditEventId),
		uniqueIndex("audit_evidence_timestamps_partition_sequence_uq")
			.on(table.partitionKey, table.chainSequence),
		index("audit_evidence_timestamps_generated_idx").on(table.generatedAt),
	]
);

export const exportApprovalRequests = pgTable(
	"export_approval_requests",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		requesterId: varchar("requester_id", { length: 100 }).notNull(),
		approverId: varchar("approver_id", { length: 100 }),
		status: varchar("status", { length: 16 }).notNull().default("pending"),
		purpose: varchar("purpose", { length: 500 }).notNull(),
		queryHash: varchar("query_hash", { length: 64 }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("export_approval_requests_status_idx").on(table.status),
		index("export_approval_requests_requester_id_idx").on(table.requesterId),
		index("export_approval_requests_expires_at_idx").on(table.expiresAt),
	]
);

export const generatedContentMarks = pgTable(
	"generated_content_marks",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		contentId: uuid("content_id").notNull(),
		modality: varchar("modality", { length: 24 }).notNull(),
		serviceProvider: varchar("service_provider", { length: 128 }).notNull(),
		generatedContent: boolean("generated_content").notNull().default(true),
		explicitMarkApplied: boolean("explicit_mark_applied").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
		metadataSignature: varchar("metadata_signature", { length: 128 }).notNull(),
		hashKeyId: varchar("hash_key_id", { length: 64 }).notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		exemptionSubjectId: varchar("exemption_subject_id", { length: 100 }),
		exemptionAgreementVersion: varchar("exemption_agreement_version", { length: 64 }),
		exemptionPurpose: varchar("exemption_purpose", { length: 500 }),
		retainUntil: timestamp("retain_until", { withTimezone: true }),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("generated_content_marks_scope_content_uq").on(table.tenantId, table.applicationId, table.contentId),
		index("generated_content_marks_created_at_idx").on(table.createdAt),
		index("generated_content_marks_retain_until_idx").on(table.retainUntil),
	]
);

export const securityIncidents = pgTable(
	"security_incidents",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		incidentNumber: varchar("incident_number", { length: 64 }).notNull(),
		title: varchar("title", { length: 200 }).notNull(),
		severity: varchar("severity", { length: 16 }).notNull(),
		status: varchar("status", { length: 24 }).notNull().default("PENDING_REVIEW"),
		traceId: varchar("trace_id", { length: 128 }),
		sessionId: varchar("session_id", { length: 128 }),
		riskType: varchar("risk_type", { length: 128 }).notNull(),
		eventAnalysis: text("event_analysis").notNull(),
		attackTechnique: text("attack_technique").notNull(),
		impact: text("impact").notNull(),
		answerEvidence: text("answer_evidence").notNull(),
		assigneeId: varchar("assignee_id", { length: 100 }),
		slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
		resolution: text("resolution"),
		version: integer("version").notNull().default(1),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		closedAt: timestamp("closed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("security_incidents_scope_number_uq").on(table.tenantId, table.applicationId, table.incidentNumber),
		index("security_incidents_status_sla_idx").on(table.status, table.slaDueAt),
		index("security_incidents_trace_id_idx").on(table.traceId),
	]
);

export const incidentTransitions = pgTable(
	"incident_transitions",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		incidentId: uuid("incident_id").notNull().references(() => securityIncidents.id, { onDelete: "restrict" }),
		fromStatus: varchar("from_status", { length: 24 }),
		toStatus: varchar("to_status", { length: 24 }).notNull(),
		actorId: varchar("actor_id", { length: 100 }).notNull(),
		assigneeId: varchar("assignee_id", { length: 100 }),
		note: text("note"),
		version: integer("version").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("incident_transitions_incident_version_uq").on(table.incidentId, table.version),
		index("incident_transitions_created_at_idx").on(table.createdAt),
	]
);

export const contentAccessRequests = pgTable(
	"content_access_requests",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		resourceType: varchar("resource_type", { length: 32 }).notNull(),
		resourceId: varchar("resource_id", { length: 128 }).notNull(),
		sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
		requesterId: varchar("requester_id", { length: 100 }).notNull(),
		purpose: varchar("purpose", { length: 40 }).notNull(),
		reason: varchar("reason", { length: 500 }).notNull(),
		status: varchar("status", { length: 16 }).notNull().default("pending"),
		reviewedBy: varchar("reviewed_by", { length: 100 }),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		decisionReason: varchar("decision_reason", { length: 500 }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		usedAt: timestamp("used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("content_access_requests_scope_status_idx")
			.on(table.tenantId, table.applicationId, table.status, table.createdAt),
		index("content_access_requests_resource_idx")
			.on(table.tenantId, table.applicationId, table.resourceType, table.resourceId),
		uniqueIndex("content_access_requests_pending_uq")
			.on(table.tenantId, table.applicationId, table.resourceType, table.resourceId, table.requesterId)
			.where(sql`status = 'pending'`),
	],
);

export const dataCatalogEntries = pgTable(
	"data_catalog_entries",
	{
		...tenantScopeColumns(), id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		assetCode: varchar("asset_code", { length: 64 }).notNull(), name: varchar("name", { length: 200 }).notNull(),
		category: varchar("category", { length: 32 }).notNull(), classificationLevel: varchar("classification_level", { length: 32 }).notNull(),
		classificationStandards: jsonb("classification_standards").$type<string[]>().notNull(),
		ownerId: varchar("owner_id", { length: 100 }).notNull(), stewardId: varchar("steward_id", { length: 100 }),
		retentionDays: integer("retention_days").notNull(), sourceSystem: varchar("source_system", { length: 200 }).notNull(),
		storageLocation: varchar("storage_location", { length: 500 }).notNull(), legalBasis: varchar("legal_basis", { length: 500 }),
		controlPolicy: jsonb("control_policy").$type<Record<string, boolean>>().notNull(), status: varchar("status", { length: 16 }).notNull().default("ACTIVE"),
		version: integer("version").notNull().default(1), createdBy: varchar("created_by", { length: 100 }).notNull(),
		updatedBy: varchar("updated_by", { length: 100 }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("data_catalog_scope_code_uq").on(table.tenantId, table.applicationId, table.assetCode), index("data_catalog_classification_idx").on(table.classificationLevel)]
);

export const dataCatalogHistory = pgTable(
	"data_catalog_history",
	{
		...tenantScopeColumns(), id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		catalogEntryId: uuid("catalog_entry_id").notNull().references(() => dataCatalogEntries.id, { onDelete: "restrict" }),
		version: integer("version").notNull(), actorId: varchar("actor_id", { length: 100 }).notNull(),
		changeType: varchar("change_type", { length: 24 }).notNull(), previousSnapshot: jsonb("previous_snapshot").$type<Record<string, unknown>>(),
		snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("data_catalog_history_entry_version_uq").on(table.catalogEntryId, table.version)]
);



// ============================================
// 18. 文档扫描任务表
// ============================================
export const documentScanTasks = pgTable(
	"document_scan_tasks",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		ownerId: varchar("owner_id", { length: 100 }),
		fileName: varchar("file_name", { length: 500 }).notNull(),
		fileType: varchar("file_type", { length: 50 }).notNull(), // txt, pdf, docx, png, jpg, etc.
		fileSize: integer("file_size"),
		fileKey: varchar("file_key", { length: 500 }), // 对象存储中的文件 key
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id),
		status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, parsing, detecting, completed, failed
		statusMessage: text("status_message"),
		extractedText: text("extracted_text"),
		parsedChunks: jsonb("parsed_chunks").$type<Array<{
			index: number;
			content: string;
			startLine: number;
			endLine: number;
			startOffset: number;
			endOffset: number;
		}>>().default([]),
		ocrEnabled: boolean("ocr_enabled").default(false),
		ocrResults: jsonb("ocr_results").$type<Array<{
			pageNumber: number;
			text: string;
		}>>().default([]),
		overallScore: integer("overall_score"),
		finalAction: varchar("final_action", { length: 20 }), // allow, warn, block
		findingsCount: integer("findings_count").default(0),
		whitelistMatched: jsonb("whitelist_matched"),
		skippedDimensions: jsonb("skipped_dimensions"),
		errorMessage: text("error_message"),
		// 预览和定位相关
		previewHtml: text("preview_html"), // 保留格式的HTML预览
		plainLines: jsonb("plain_lines").$type<Array<{
			lineNumber: number;
			text: string;
			startOffset: number;
			endOffset: number;
		}>>().default([]),
		parseMeta: jsonb("parse_meta").$type<{
			hasTables?: boolean;
			hasImages?: boolean;
			totalLines?: number;
			totalChars?: number;
		}>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		contentExpiresAt: timestamp("content_expires_at", { withTimezone: true }),
	},
	(table) => [
		index("document_scan_tasks_owner_id_idx").on(table.ownerId),
		index("document_scan_tasks_policy_id_idx").on(table.policyId),
		index("document_scan_tasks_status_idx").on(table.status),
		index("document_scan_tasks_created_at_idx").on(table.createdAt),
	]
);

// ============================================
// 19. 文档扫描风险发现表
// ============================================
export const documentScanFindings = pgTable(
	"document_scan_findings",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		taskId: uuid("task_id").notNull().references(() => documentScanTasks.id, { onDelete: "cascade" }),
		chunkIndex: integer("chunk_index"),
		lineNumber: integer("line_number"),
		startOffset: integer("start_offset"),
		endOffset: integer("end_offset"),
		locationStatus: varchar("location_status", { length: 20 }).default("located"), // located, not_found
		// 维度信息
		dimensionId: uuid("dimension_id"),
		dimensionCode: varchar("dimension_code", { length: 100 }),
		dimensionName: varchar("dimension_name", { length: 200 }),
		// 规则信息
		ruleId: uuid("rule_id"),
		ruleName: varchar("rule_name", { length: 200 }),
		ruleType: varchar("rule_type", { length: 20 }), // keyword, regex, semantic, llm
		// 风险评估
		score: integer("score").notNull(),
		severity: varchar("severity", { length: 20 }).notNull(), // low, medium, high, critical
		action: varchar("action", { length: 20 }).notNull(), // allow, warn, block, mask, rewrite
		// 证据
		evidence: jsonb("evidence").$type<string[]>().default([]),
		maskedEvidence: jsonb("masked_evidence").$type<string[]>().default([]),
		// 说明
		reason: text("reason"),
		suggestion: text("suggestion"),
		// 白名单
		whitelistMatched: jsonb("whitelist_matched"),
		skippedDimensions: jsonb("skipped_dimensions"),
		// 状态
		status: varchar("status", { length: 20 }).default("open").notNull(), // open, accepted, ignored
		ignoreReason: varchar("ignore_reason", { length: 50 }), // false_positive, test_data, education, acceptable, other
		ignoreNote: text("ignore_note"),
		ignoredAt: timestamp("ignored_at", { withTimezone: true }),
		ignoredBy: varchar("ignored_by", { length: 100 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("document_scan_findings_task_id_idx").on(table.taskId),
		index("document_scan_findings_dimension_code_idx").on(table.dimensionCode),
		index("document_scan_findings_status_idx").on(table.status),
		index("document_scan_findings_severity_idx").on(table.severity),
	]
);

// ============================================
// 1. 模型供应商配置表
// ============================================
export const secretEnvelopes = pgTable(
	"secret_envelopes",
	{
		...tenantScopeColumns(),
		ref: varchar("ref", { length: 80 }).primaryKey(),
		keyId: varchar("key_id", { length: 100 }).notNull(),
		algorithm: varchar("algorithm", { length: 30 }).notNull().default("AES-256-GCM"),
		iv: varchar("iv", { length: 32 }).notNull(),
		ciphertext: text("ciphertext").notNull(),
		authTag: varchar("auth_tag", { length: 32 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("secret_envelopes_key_id_idx").on(table.keyId)]
);

export const llmProviders = pgTable(
	"llm_providers",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 100 }).notNull(),
		displayName: varchar("display_name", { length: 200 }).notNull(),
		providerType: varchar("provider_type", { length: 50 }).notNull(), // OpenAI-compatible family, Ollama, or custom compatible endpoint
		baseUrl: varchar("base_url", { length: 500 }),
		secretRef: varchar("secret_ref", { length: 80 }).references(() => secretEnvelopes.ref, { onDelete: "set null" }),
		apiKeyEncrypted: text("api_key_encrypted"),
		defaultModel: varchar("default_model", { length: 100 }),
		useCase: varchar("use_case", { length: 20 }), // 'target', 'judge', 'both', 'ocr'
		isEnabled: boolean("is_enabled").default(true).notNull(),
		isDefaultTarget: boolean("is_default_target").default(false).notNull(),
		isDefaultJudge: boolean("is_default_judge").default(false).notNull(),
		avgLatencyMs: integer("avg_latency_ms"),
		lastTestAt: timestamp("last_test_at", { withTimezone: true }),
		lastTestSuccess: boolean("last_test_success"),
		configJson: jsonb("config_json"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		createdBy: varchar("created_by", { length: 100 }).default("system").notNull(),
	},
	(table) => [
		uniqueIndex("llm_providers_scope_name_uq").on(table.tenantId, table.applicationId, table.name),
		index("llm_providers_name_idx").on(table.name),
		index("llm_providers_is_enabled_idx").on(table.isEnabled),
	]
);

// ============================================
// 2. 策略方案表
// ============================================
export const policyProfiles = pgTable(
	"policy_profiles",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 100 }).notNull(),
		description: text("description"),
		isDefault: boolean("is_default").default(false).notNull(),
		isActive: boolean("is_active").default(true).notNull(),
		version: integer("version").default(1).notNull(),
		tags: jsonb("tags").$type<string[]>().default([]),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
		// 策略升级配置
		escalationEnabled: boolean("escalation_enabled").default(false).notNull(),
		escalationThreshold: integer("escalation_threshold").default(5).notNull(), // 连续警告次数阈值
		escalationTargetPolicyId: varchar("escalation_target_policy_id", { length: 36 }).references((): AnyPgColumn => policyProfiles.id), // 升级到的目标策略ID
		deescalationThreshold: integer("deescalation_threshold").default(1).notNull(), // 降级需要连续allow次数
		escalationCooldownMinutes: integer("escalation_cooldown_minutes").default(30).notNull(), // 升级后冷却期（分钟）
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		createdBy: varchar("created_by", { length: 100 }).default("system").notNull(),
	},
	(table) => [
		uniqueIndex("policy_profiles_scope_name_uq").on(table.tenantId, table.applicationId, table.name),
		index("policy_profiles_name_idx").on(table.name),
		index("policy_profiles_is_default_idx").on(table.isDefault),
		index("policy_profiles_is_active_idx").on(table.isActive),
	]
);

// ============================================
// 3. 策略规则表
// ============================================
export const policyRules = pgTable(
	"policy_rules",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		dimension: varchar("dimension", { length: 50 }).notNull(), // 'prompt_injection', 'pii_leak', 'malicious_code', 'violence_hate', 'illegal_content'
		enabled: boolean("enabled").default(true).notNull(),
		warnEnabled: boolean("warn_enabled").default(true).notNull(), // 是否启用警告
		blockEnabled: boolean("block_enabled").default(true).notNull(), // 是否启用阻断
		warnThreshold: decimal("warn_threshold", { precision: 5, scale: 2 }).default("50.00").notNull(),
		blockThreshold: decimal("block_threshold", { precision: 5, scale: 2 }).default("80.00").notNull(),
		autoMask: boolean("auto_mask").default(false).notNull(),
		autoRewrite: boolean("auto_rewrite").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("policy_rules_policy_id_idx").on(table.policyId),
		index("policy_rules_dimension_idx").on(table.dimension),
	]
);

// ============================================
// 4. 关键词分类表
// ============================================
export const keywordCategories = pgTable(
	"keyword_categories",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		name: varchar("name", { length: 100 }).notNull(),
		dimension: varchar("dimension", { length: 50 }).notNull(),
		description: text("description"),
		priority: integer("priority").default(100).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("keyword_categories_policy_id_idx").on(table.policyId),
		index("keyword_categories_dimension_idx").on(table.dimension),
	]
);

// ============================================
// 5. 受治理词典发布与响应模板
// ============================================
export const dictionaryReleaseSets = pgTable('dictionary_release_sets', {
  ...tenantScopeColumns(),
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  policyId: varchar('policy_id', {length:36}).notNull().references(()=>policyProfiles.id, {onDelete:'restrict'}),
  dictionaryId: varchar('dictionary_id', {length:128}).notNull(),
  version: varchar('version', {length:64}).notNull(),
  state: varchar('state', {length:32}).notNull().default('draft'),
  revision: integer('revision').notNull().default(1),
  canonicalManifest: jsonb('canonical_manifest').$type<Record<string,unknown>>().notNull(),
  contentHash: varchar('content_hash', {length:64}).notNull(),
  signature: text('signature').notNull(),
  signingKeyId: varchar('signing_key_id', {length:128}).notNull(),
  shardCount: integer('shard_count').notNull(),
  submittedBy: varchar('submitted_by', {length:100}).notNull(),
  approvedBy: varchar('approved_by', {length:100}),
  approvedAt: timestamp('approved_at', {withTimezone:true}),
  previousSetId: uuid('previous_set_id'),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull().defaultNow(),
}, table=>[
  uniqueIndex('dictionary_release_sets_scope_version_uq').on(table.tenantId,table.applicationId,table.dictionaryId,table.version),
  uniqueIndex('dictionary_release_sets_scope_id_uq').on(table.tenantId,table.applicationId,table.id),
  uniqueIndex('dictionary_release_sets_one_active_uq').on(table.tenantId,table.applicationId,table.dictionaryId).where(sql`${table.state} = 'active'`),
]);

export const dictionaryReleases = pgTable(
	"dictionary_releases",
	{
		...tenantScopeColumns(),
		releaseSetId: uuid('release_set_id').references(()=>dictionaryReleaseSets.id, {onDelete:'restrict'}),
		partNumber: integer('part_number'),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		dictionaryId: varchar("dictionary_id", { length: 128 }).notNull(),
		version: varchar("version", { length: 64 }).notNull(),
		state: varchar("state", { length: 32 }).notNull().default("draft"),
		canonicalManifest: jsonb("canonical_manifest").$type<Record<string, unknown>>().notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		signature: text("signature").notNull(),
		signatureAlgorithm: varchar("signature_algorithm", { length: 32 }).notNull().default("Ed25519"),
		signingKeyId: varchar("signing_key_id", { length: 128 }).notNull(),
		entryCount: integer("entry_count").notNull().default(0),
		statistics: jsonb("statistics").$type<Record<string, unknown>>().notNull().default({}),
		submittedBy: varchar("submitted_by", { length: 100 }).notNull(),
		approvedBy: varchar("approved_by", { length: 100 }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
		rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
		rollbackOfId: uuid("rollback_of_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("dictionary_releases_scope_dictionary_version_uq")
			.on(table.tenantId, table.applicationId, table.dictionaryId, table.version),
		index("dictionary_releases_scope_state_idx")
			.on(table.tenantId, table.applicationId, table.state),
		index("dictionary_releases_content_hash_idx").on(table.contentHash),
	]
);

export const dictionaryReleaseTransitions = pgTable(
	"dictionary_release_transitions",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		releaseId: uuid("release_id").notNull().references(() => dictionaryReleases.id, { onDelete: "restrict" }),
		fromState: varchar("from_state", { length: 32 }),
		toState: varchar("to_state", { length: 32 }).notNull(),
		action: varchar("action", { length: 32 }).notNull(),
		actorId: varchar("actor_id", { length: 100 }).notNull(),
		reason: varchar("reason", { length: 500 }),
		manifestHash: varchar("manifest_hash", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("dictionary_release_transitions_release_idx").on(table.releaseId, table.createdAt),
		index("dictionary_release_transitions_scope_idx").on(table.tenantId, table.applicationId, table.createdAt),
	]
);

export const responseTemplates = pgTable(
	"response_templates",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		templateKey: varchar("template_key", { length: 128 }).notNull(),
		riskCategory: varchar("risk_category", { length: 128 }).notNull(),
		action: varchar("action", { length: 32 }).notNull(),
		locale: varchar("locale", { length: 64 }).notNull().default("zh-CN"),
		industry: varchar("industry", { length: 128 }).notNull().default("general"),
		jurisdiction: varchar("jurisdiction", { length: 128 }).notNull().default("global"),
		businessLine: varchar("business_line", { length: 128 }).notNull().default("general"),
		legalDisclaimerVersion: varchar("legal_disclaimer_version", { length: 128 }).notNull().default("none"),
		templateScope: varchar("template_scope", { length: 32 }).notNull().default("TENANT"),
		templateText: text("template_text").notNull(),
		allowedVariables: jsonb("allowed_variables").$type<string[]>().notNull().default([]),
		version: integer("version").notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		signatureDigest: varchar("signature_digest", { length: 64 }).notNull(),
		approvalStatus: varchar("approval_status", { length: 32 }).notNull().default("pending"),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		approvedBy: varchar("approved_by", { length: 100 }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
		validTo: timestamp("valid_to", { withTimezone: true }),
		enabled: boolean("enabled").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("response_templates_scope_key_version_uq")
			.on(table.tenantId, table.applicationId, table.templateKey, table.version),
		index("response_templates_scope_status_idx")
			.on(table.tenantId, table.applicationId, table.approvalStatus, table.enabled),
	]
);

// ============================================
// 5.1 自定义关键词规则表
// ============================================
export const keywordRules = pgTable(
	"keyword_rules",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		categoryId: varchar("category_id", { length: 36 }).references(() => keywordCategories.id, { onDelete: "set null" }),
		releaseId: uuid("release_id").references(() => dictionaryReleases.id, { onDelete: "restrict" }),
		dimension: varchar("dimension", { length: 50 }).notNull(),
		keyword: varchar("keyword", { length: 500 }).notNull(),
		canonicalTerm: varchar("canonical_term", { length: 500 }),
		variantType: varchar("variant_type", { length: 32 }).notNull().default("canonical"),
		locale: varchar("locale", { length: 64 }).notNull().default("und"),
		direction: varchar("direction", { length: 32 }).notNull().default("BOTH"),
		industry: varchar("industry", { length: 128 }).notNull().default("general"),
		contexts: jsonb("contexts").$type<string[]>().notNull().default([]),
		severity: varchar("severity", { length: 20 }).notNull().default("MEDIUM"),
		mandatoryDeny: boolean("mandatory_deny").notNull().default(false),
		validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
		validTo: timestamp("valid_to", { withTimezone: true }),
		owner: varchar("owner", { length: 100 }),
		evidenceRequirement: varchar("evidence_requirement", { length: 500 }),
		score: decimal("score", { precision: 5, scale: 2 }).default("90.00").notNull(),
		matchType: varchar("match_type", { length: 20 }).default("exact").notNull(), // 'exact', 'prefix', 'suffix', 'regex'
		caseSensitive: boolean("case_sensitive").default(false).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		description: text("description"),
		tags: jsonb("tags").$type<string[]>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("keyword_rules_policy_id_idx").on(table.policyId),
		index("keyword_rules_category_id_idx").on(table.categoryId),
		index("keyword_rules_dimension_idx").on(table.dimension),
		index("keyword_rules_keyword_idx").on(table.keyword),
		index("keyword_rules_release_idx").on(table.releaseId),
		index("keyword_rules_validity_idx").on(table.validFrom, table.validTo),
	]
);

export const detectorCalibrations = pgTable(
	"detector_calibrations",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		detectorId: varchar("detector_id", { length: 128 }).notNull(),
		detectorVersion: varchar("detector_version", { length: 64 }).notNull(),
		riskType: varchar("risk_type", { length: 128 }).notNull(),
		locale: varchar("locale", { length: 64 }).notNull().default("und"),
		industry: varchar("industry", { length: 128 }).notNull().default("general"),
		threshold: decimal("threshold", { precision: 6, scale: 5 }).notNull(),
		confidenceFloor: decimal("confidence_floor", { precision: 6, scale: 5 }).notNull(),
		metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
		datasetHash: varchar("dataset_hash", { length: 64 }).notNull(),
		bundleId: varchar("bundle_id", { length: 36 }),
		approvedBy: varchar("approved_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("detector_calibrations_scope_identity_uq").on(
			table.tenantId,
			table.applicationId,
			table.detectorId,
			table.detectorVersion,
			table.riskType,
			table.locale,
			table.industry,
		),
		index("detector_calibrations_scope_detector_idx")
			.on(table.tenantId, table.applicationId, table.detectorId),
	]
);

export const badcaseFeedback = pgTable(
	"badcase_feedback",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		decisionId: varchar("decision_id", { length: 128 }),
		riskType: varchar("risk_type", { length: 128 }).notNull(),
		predictedAction: varchar("predicted_action", { length: 32 }).notNull(),
		expectedAction: varchar("expected_action", { length: 32 }).notNull(),
		evidenceHmacs: jsonb("evidence_hmacs").$type<string[]>().notNull().default([]),
		classification: varchar("classification", { length: 32 }).notNull(),
		status: varchar("status", { length: 32 }).notNull().default("open"),
		reviewerId: varchar("reviewer_id", { length: 100 }),
		disposition: varchar("disposition", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		index("badcase_feedback_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
		index("badcase_feedback_request_hash_idx").on(table.requestHash),
	]
);

// ============================================
// 6. 策略版本历史表
// ============================================
export const policyVersions = pgTable(
	"policy_versions",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		snapshot: jsonb("snapshot").notNull(),
		changeSummary: text("change_summary"),
		changedBy: varchar("changed_by", { length: 100 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("policy_versions_policy_id_idx").on(table.policyId),
	]
);

// ============================================
// 7. 检测会话表
// ============================================
export const detectionSessions = pgTable(
	"detection_sessions",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		userId: varchar("user_id", { length: 100 }),
		userPrompt: text("user_prompt"),
		userPromptHash: varchar("user_prompt_hash", { length: 64 }),
		mockModelOutput: text("mock_model_output"),
		mockModelOutputHash: varchar("mock_model_output_hash", { length: 64 }),
		finalResponse: text("final_response"),
		finalResponseHash: varchar("final_response_hash", { length: 64 }),
		inputAction: varchar("input_action", { length: 20 }), // 'block', 'warn', 'allow', 'mask', 'rewrite'
		inputScore: decimal("input_score", { precision: 5, scale: 2 }),
		inputSummary: text("input_summary"),
		outputAction: varchar("output_action", { length: 20 }),
		outputScore: decimal("output_score", { precision: 5, scale: 2 }),
		outputSummary: text("output_summary"),
		finalAction: varchar("final_action", { length: 20 }),
		policyId: varchar("policy_id", { length: 36 }).references(() => policyProfiles.id),
		targetProviderId: varchar("target_provider_id", { length: 36 }).references(() => llmProviders.id, ),
		judgeProviderId: varchar("judge_provider_id", { length: 36 }).references(() => llmProviders.id, ),
		durationMs: integer("duration_ms"),
		// 白名单命中信息
		whitelistMatched: jsonb("whitelist_matched").$type<{
			id: string;
			name: string;
			policyScope: string;
			dimensionScope: string;
			dimensionCodes: string[];
			effect: string;
		}>(),
		skippedDimensions: jsonb("skipped_dimensions").$type<Array<{
			dimensionCode: string;
			dimensionName: string;
			whitelistId: string;
			whitelistName: string;
			effect: string;
		}>>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("detection_sessions_user_id_idx").on(table.userId),
		index("detection_sessions_final_action_idx").on(table.finalAction),
		index("detection_sessions_created_at_idx").on(table.createdAt),
		index("detection_sessions_policy_id_idx").on(table.policyId),
		index("detection_sessions_scope_created_idx").on(table.tenantId, table.applicationId, table.createdAt),
	]
);

// ============================================
// 8. 检测记录表
// ============================================
export const detectionRecords = pgTable(
	"detection_records",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		sessionId: varchar("session_id", { length: 36 }).notNull().references(() => detectionSessions.id, { onDelete: "cascade" }),
		direction: varchar("direction", { length: 10 }).notNull(), // 'input', 'output'
		rawText: text("raw_text"),
		rawTextHash: varchar("raw_text_hash", { length: 64 }),
		maskedText: text("masked_text"),
		rewrittenText: text("rewritten_text"),
		overallScore: decimal("overall_score", { precision: 5, scale: 2 }),
		confidence: decimal("confidence", { precision: 3, scale: 2 }),
		action: varchar("action", { length: 20 }),
		processingAction: varchar("processing_action", { length: 20 }), // 'none', 'mask', 'rewrite'
		summary: text("summary"),
		ruleLatencyMs: integer("rule_latency_ms"),
		cozeLatencyMs: integer("coze_latency_ms"),
		totalLatencyMs: integer("total_latency_ms"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("detection_records_session_id_idx").on(table.sessionId),
		index("detection_records_direction_idx").on(table.direction),
		index("detection_records_action_idx").on(table.action),
		index("detection_records_scope_session_idx").on(table.tenantId, table.applicationId, table.sessionId),
	]
);

// ============================================
// 9. 风险明细表
// ============================================
export const riskFindings = pgTable(
	"risk_findings",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		recordId: varchar("record_id", { length: 36 }).notNull().references(() => detectionRecords.id, { onDelete: "cascade" }),
		dimension: varchar("dimension", { length: 50 }).notNull(),
		score: decimal("score", { precision: 5, scale: 2 }),
		confidence: decimal("confidence", { precision: 3, scale: 2 }),
		severity: varchar("severity", { length: 20 }), // 'critical', 'high', 'medium', 'low'
		matchedRules: jsonb("matched_rules").$type<string[]>(),
		evidence: jsonb("evidence").$type<string[]>(),
		reason: text("reason"),
		suggestion: text("suggestion"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("risk_findings_record_id_idx").on(table.recordId),
		index("risk_findings_dimension_idx").on(table.dimension),
		index("risk_findings_severity_idx").on(table.severity),
		index("risk_findings_scope_record_idx").on(table.tenantId, table.applicationId, table.recordId),
	]
);

// ============================================
// 10. 测试用例表
// ============================================
export const testCases = pgTable(
	"test_cases",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		title: varchar("title", { length: 200 }).notNull(),
		description: text("description"),
		category: varchar("category", { length: 50 }).notNull(), // 'normal_qa', 'prompt_injection', 'pii_leak', etc.
		inputText: text("input_text").notNull(),
		outputText: text("output_text"),
		expectedAction: varchar("expected_action", { length: 20 }),
		expectedDimensions: jsonb("expected_dimensions").$type<string[]>(),
		expectedScoreMin: decimal("expected_score_min", { precision: 5, scale: 2 }),
		expectedScoreMax: decimal("expected_score_max", { precision: 5, scale: 2 }),
		severity: varchar("severity", { length: 20 }),
		enabled: boolean("enabled").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("test_cases_category_idx").on(table.category),
		index("test_cases_enabled_idx").on(table.enabled),
	]
);

// ============================================
// 11. 批量评估任务表
// ============================================
export const evaluationRuns = pgTable(
	"evaluation_runs",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		userId: varchar("user_id", { length: 100 }),
		policyId: varchar("policy_id", { length: 36 }).references(() => policyProfiles.id),
		bundleId: varchar("bundle_id", { length: 36 }).references((): AnyPgColumn => policyBundles.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }),
		datasetHash: varchar("dataset_hash", { length: 64 }),
		requestHash: varchar("request_hash", { length: 64 }),
		testCaseIds: jsonb("test_case_ids").$type<string[]>().notNull(),
		status: varchar("status", { length: 20 }).default("pending").notNull(), // 'pending', 'running', 'completed', 'failed'
		totalCases: integer("total_cases").notNull(),
		completedCases: integer("completed_cases").default(0).notNull(),
		accuracy: decimal("accuracy", { precision: 5, scale: 2 }),
		falsePositiveRate: decimal("false_positive_rate", { precision: 5, scale: 2 }),
		falseNegativeRate: decimal("false_negative_rate", { precision: 5, scale: 2 }),
		recall: decimal("recall", { precision: 5, scale: 2 }),
		f1Score: decimal("f1_score", { precision: 5, scale: 2 }),
		metrics: jsonb("metrics").$type<Record<string, unknown>>().default({}),
		attempt: integer("attempt").default(0).notNull(),
		maxAttempts: integer("max_attempts").default(3).notNull(),
		failureHistory: jsonb("failure_history").$type<Array<{
			attempt: number;
			at: string;
			code: string;
			message: string;
		}>>().default([]).notNull(),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("evaluation_runs_user_id_idx").on(table.userId),
		index("evaluation_runs_status_idx").on(table.status),
		index("evaluation_runs_policy_id_idx").on(table.policyId),
		uniqueIndex("evaluation_runs_scope_idempotency_uq").on(table.tenantId, table.applicationId, table.idempotencyKey),
		index("evaluation_runs_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
	]
);

// ============================================
// 12. 检测维度表（可自定义维度）
// ============================================
export const detectionDimensions = pgTable(
	"detection_dimensions",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		code: varchar("code", { length: 50 }).notNull(),
		name: varchar("name", { length: 100 }).notNull(),
		description: text("description"),
		category: varchar("category", { length: 50 }),
		weight: decimal("weight", { precision: 5, scale: 2 }).default("1.00").notNull(),
		priority: integer("priority").default(100).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		isSystem: boolean("is_system").default(false).notNull(),
		config: jsonb("config").$type<Record<string, unknown>>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("detection_dimensions_scope_code_uq").on(table.tenantId, table.applicationId, table.code),
		index("detection_dimensions_code_idx").on(table.code),
		index("detection_dimensions_enabled_idx").on(table.enabled),
	]
);

// ============================================
// 13. 规则组表
// ============================================
export const ruleGroups = pgTable(
	"rule_groups",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		dimensionId: varchar("dimension_id", { length: 36 }).notNull().references(() => detectionDimensions.id, { onDelete: "cascade" }),
		name: varchar("name", { length: 100 }).notNull(),
		description: text("description"),
		logic: varchar("logic", { length: 10 }).default("OR").notNull(),
		score: decimal("score", { precision: 5, scale: 2 }).default("50.00").notNull(),
		priority: integer("priority").default(100).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("rule_groups_dimension_id_idx").on(table.dimensionId),
	]
);

// ============================================
// 14. 检测规则表
// ============================================
export const detectionRules = pgTable(
	"detection_rules",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		dimensionId: varchar("dimension_id", { length: 36 }).notNull().references(() => detectionDimensions.id, { onDelete: "cascade" }),
		groupId: varchar("group_id", { length: 36 }).references(() => ruleGroups.id, { onDelete: "set null" }),
		name: varchar("name", { length: 100 }).notNull(),
		type: varchar("type", { length: 20 }).notNull(), // keyword, regex, semantic, llm
		pattern: text("pattern"),
		matchType: varchar("match_type", { length: 20 }).default("contains").notNull(),
		caseSensitive: boolean("case_sensitive").default(false).notNull(),
		score: decimal("score", { precision: 5, scale: 2 }).default("50.00").notNull(),
		confidence: decimal("confidence", { precision: 5, scale: 2 }).default("80.00").notNull(),
		priority: integer("priority").default(100).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		description: text("description"),
		suggestion: text("suggestion"), // 修复建议
		config: jsonb("config").$type<Record<string, unknown>>().default({}),
		tags: jsonb("tags").$type<string[]>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("detection_rules_dimension_id_idx").on(table.dimensionId),
		index("detection_rules_group_id_idx").on(table.groupId),
		index("detection_rules_type_idx").on(table.type),
	]
);

// ============================================
// 15. 白名单规则表
// ============================================
export const whitelistRules = pgTable(
	"whitelist_rules",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		// 兼容旧字段，新逻辑优先使用 policyScope 和 dimensionScope
		policyId: varchar("policy_id", { length: 36 }).references(() => policyProfiles.id, { onDelete: "cascade" }),
		dimensionId: varchar("dimension_id", { length: 36 }).references(() => detectionDimensions.id, { onDelete: "cascade" }),
		// 新增字段
		name: varchar("name", { length: 200 }),
		description: text("description"),
		policyScope: varchar("policy_scope", { length: 20 }).default("specific").notNull(), // 'all' | 'specific'
		dimensionScope: varchar("dimension_scope", { length: 20 }).default("specific").notNull(), // 'all' | 'specific'
		dimensionCodes: jsonb("dimension_codes").$type<string[]>().default([]),
		targetRuleIds: jsonb("target_rule_ids").$type<string[]>().default([]).notNull(),
		directions: jsonb("directions").$type<Array<
			'INPUT' | 'OUTPUT_COMPLETE' | 'OUTPUT_CHUNK' | 'RAG_INGEST' | 'RAG_CONTEXT' | 'TOOL_REQUEST' | 'TOOL_RESULT'
		>>().default([]).notNull(),
		validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		approvalStatus: varchar("approval_status", { length: 32 }).default("pending").notNull(),
		approvedBy: varchar("approved_by", { length: 100 }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		priority: integer("priority").default(100).notNull(),
		// 匹配规则
		pattern: text("pattern").notNull(),
		matchType: varchar("match_type", { length: 20 }).default("contains").notNull(),
		caseSensitive: boolean("case_sensitive").default(false).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
	},
	(table) => [
		index("whitelist_rules_policy_id_idx").on(table.policyId),
		index("whitelist_rules_dimension_id_idx").on(table.dimensionId),
		index("whitelist_rules_policy_scope_idx").on(table.policyScope),
		index("whitelist_rules_dimension_scope_idx").on(table.dimensionScope),
		index("whitelist_rules_enabled_idx").on(table.enabled),
		index("whitelist_rules_priority_idx").on(table.priority),
		index("whitelist_rules_expires_at_idx").on(table.expiresAt),
		index("whitelist_rules_approval_idx").on(table.approvalStatus, table.validFrom),
	]
);

// ============================================
// 15.1 白名单规则-策略关联表
// 当 policyScope = 'specific' 时，通过此表关联多个策略
// ============================================
export const whitelistRulePolicies = pgTable(
	"whitelist_rule_policies",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()::text`),
		whitelistRuleId: varchar("whitelist_rule_id", { length: 36 }).notNull().references(() => whitelistRules.id, { onDelete: "cascade" }),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("whitelist_rule_policies_whitelist_rule_id_idx").on(table.whitelistRuleId),
		index("whitelist_rule_policies_policy_id_idx").on(table.policyId),
	]
);

// ============================================
// 16. 策略维度配置表
// ============================================
export const policyDimensionConfig = pgTable(
	"policy_dimension_config",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),
		dimensionId: varchar("dimension_id", { length: 36 }).notNull().references(() => detectionDimensions.id, { onDelete: "cascade" }),
		enabled: boolean("enabled").default(true).notNull(),
		warnEnabled: boolean("warn_enabled").default(true).notNull(),
		blockEnabled: boolean("block_enabled").default(true).notNull(),
		warnThreshold: integer("warn_threshold").default(50).notNull(),
		blockThreshold: integer("block_threshold").default(80).notNull(),
		autoMask: boolean("auto_mask").default(false).notNull(),
		autoRewrite: boolean("auto_rewrite").default(false).notNull(),
		customWeight: decimal("custom_weight", { precision: 5, scale: 2 }),
		actionConfig: jsonb("action_config").$type<{
			low?: string;
			medium?: string;
			high?: string;
			enableMask?: boolean;
			enableRewrite?: boolean;
			fallbackMessage?: string;
		}>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("policy_dimension_config_policy_id_idx").on(table.policyId),
		index("policy_dimension_config_dimension_id_idx").on(table.dimensionId),
	]
);

// ============================================
// 17. Agent运行日志表
// ============================================
export const agentTraces = pgTable(
	"agent_traces",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		recordId: varchar("record_id", { length: 36 }).references(() => detectionRecords.id, { onDelete: "cascade" }),
		providerId: varchar("provider_id", { length: 36 }).references(() => llmProviders.id),
		workflowName: varchar("workflow_name", { length: 100 }),
		requestPayload: jsonb("request_payload"),
		responsePayload: jsonb("response_payload"),
		latencyMs: integer("latency_ms"),
		success: boolean("success").notNull(),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("agent_traces_record_id_idx").on(table.recordId),
		index("agent_traces_provider_id_idx").on(table.providerId),
		index("agent_traces_created_at_idx").on(table.createdAt),
	]
);

// ============================================
// 18. 用户表
// ============================================
export const users = pgTable(
	"users",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		username: varchar("username", { length: 50 }).notNull().unique(),
		nickname: varchar("nickname", { length: 100 }),
		email: varchar("email", { length: 255 }),
		password: varchar("password", { length: 255 }).notNull(), // 存储加密后的密码
		phone: varchar("phone", { length: 20 }),
		avatar: varchar("avatar", { length: 500 }),
		role: varchar("role", { length: 20 }).notNull().default("user"), // 'admin', 'user'
		status: varchar("status", { length: 20 }).notNull().default("active"), // 'active', 'disabled', 'locked'
		department: varchar("department", { length: 100 }),
		description: text("description"),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
		lastLoginIp: varchar("last_login_ip", { length: 50 }),
		loginCount: integer("login_count").default(0),
		failedLoginCount: integer("failed_login_count").default(0),
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		tokenVersion: integer("token_version").notNull().default(0),
		passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
		mustChangePassword: boolean("must_change_password").default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		createdBy: varchar("created_by", { length: 36 }),
	},
	(table) => [
		index("users_username_idx").on(table.username),
		index("users_email_idx").on(table.email),
		index("users_role_idx").on(table.role),
		index("users_status_idx").on(table.status),
	]
);

export const passwordHistory = pgTable(
	"password_history",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
		passwordHash: varchar("password_hash", { length: 255 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("password_history_user_created_idx").on(table.userId, table.createdAt),
	]
);

export const tenantMemberships = pgTable(
	"tenant_memberships",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		tenantId: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "cascade" }),
		userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
		defaultApplicationId: varchar("default_application_id", { length: 36 }).notNull().references(() => applications.id, { onDelete: "restrict" }),
		status: varchar("status", { length: 20 }).notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("tenant_memberships_tenant_user_uq").on(table.tenantId, table.userId),
		index("tenant_memberships_user_status_idx").on(table.userId, table.status),
	]
);

// ============================================
// 19. 裁判模型配置表
// ============================================
export const policyJudgeConfigs = pgTable(
	"policy_judge_configs",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "cascade" }),

		// 基础配置
		enabled: boolean("enabled").default(false).notNull(),
		providerId: varchar("provider_id", { length: 36 }).references(() => llmProviders.id),
		mode: varchar("mode", { length: 20 }).default("conservative").notNull(), // conservative, balanced, review_only
		triggerMode: varchar("trigger_mode", { length: 20 }).default("risk_or_semantic").notNull(), // risk_only, risk_or_semantic, always

		// 触发条件
		triggerThreshold: integer("trigger_threshold").default(40).notNull(), // 规则分数达到此值触发
		judgeThreshold: integer("judge_threshold").default(70).notNull(), // 裁判判断阈值
		weight: decimal("weight", { precision: 3, scale: 2 }).default("0.50").notNull(), // 平衡模式权重

		// 适用范围
		applyToInput: boolean("apply_to_input").default(true).notNull(),
		applyToOutput: boolean("apply_to_output").default(true).notNull(),
		enabledDimensions: jsonb("enabled_dimensions").$type<string[]>().default([]), // 适用的维度code列表
		semanticDimensions: jsonb("semantic_dimensions").$type<string[]>().default([]), // 需要语义增强的维度

		// 超时与失败处理
		timeoutMs: integer("timeout_ms").default(8000).notNull(),
		fallbackAction: varchar("fallback_action", { length: 20 }).default("rule").notNull(), // rule, allow, block
		failClosedForHighRisk: boolean("fail_closed_for_high_risk").default(true).notNull(),

		// 数据保护
		maxTextLength: integer("max_text_length").default(6000).notNull(),
		maskPiiBeforeJudge: boolean("mask_pii_before_judge").default(true).notNull(),
		blockExternalForSecrets: boolean("block_external_for_secrets").default(true).notNull(),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("policy_judge_configs_policy_id_idx").on(table.policyId),
		index("policy_judge_configs_enabled_idx").on(table.enabled),
	]
);

// ============================================
// 20. 裁判模型调用记录表
// ============================================
export const judgeModelInvocations = pgTable(
	"judge_model_invocations",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

		// 关联信息
		sessionId: varchar("session_id", { length: 36 }),
		policyId: varchar("policy_id", { length: 36 }).references(() => policyProfiles.id),
		providerId: varchar("provider_id", { length: 36 }).references(() => llmProviders.id),

		// 输入信息
		direction: varchar("direction", { length: 10 }), // input, output
		modelName: varchar("model_name", { length: 100 }),
		promptVersion: varchar("prompt_version", { length: 20 }),
		inputHash: varchar("input_hash", { length: 64 }),
		textLength: integer("text_length"),

		// 规则检测结果
		ruleScore: integer("rule_score"),
		ruleAction: varchar("rule_action", { length: 20 }),
		ruleFindings: jsonb("rule_findings").$type<Array<{
			dimension: string;
			dimensionName: string;
			score: number;
			action: string;
			reason: string;
		}>>().default([]),

		// 裁判模型结果
		judgeScore: integer("judge_score"),
		judgeConfidence: decimal("judge_confidence", { precision: 3, scale: 2 }),
		judgeAction: varchar("judge_action", { length: 20 }),
		judgeReason: text("judge_reason"),
		judgeDimensions: jsonb("judge_dimensions").$type<Array<{
			dimensionCode: string;
			dimensionName: string;
			hasRisk: boolean;
			score: number;
			confidence: number;
			reason: string;
		}>>().default([]),

		// 规则复核
		ruleReview: jsonb("rule_review").$type<{
			agreeWithRules: boolean;
			falsePositiveSuspected: boolean;
			falseNegativeSuspected: boolean;
			explanation: string;
		}>(),

		// 原始响应与解析
		rawResponse: jsonb("raw_response"),
		parseError: text("parse_error"),
		errorMessage: text("error_message"),

		// 性能指标
		latencyMs: integer("latency_ms"),
		promptTokens: integer("prompt_tokens"),
		completionTokens: integer("completion_tokens"),
		totalTokens: integer("total_tokens"),

		// 决策影响
		usedInDecision: boolean("used_in_decision").default(false).notNull(),
		decisionMode: varchar("decision_mode", { length: 20 }),
		finalScore: integer("final_score"),
		finalAction: varchar("final_action", { length: 20 }),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("judge_model_invocations_session_id_idx").on(table.sessionId),
		index("judge_model_invocations_policy_id_idx").on(table.policyId),
		index("judge_model_invocations_created_at_idx").on(table.createdAt),
	]
);


// ============================================
// 21. 评估结果表
// ============================================
export const evaluationResults = pgTable(
	"evaluation_results",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		runId: varchar("run_id", { length: 36 }).notNull().references(() => evaluationRuns.id, { onDelete: "cascade" }),
		testCaseId: varchar("test_case_id", { length: 36 }).notNull().references(() => testCases.id, { onDelete: "cascade" }),
		expectedAction: varchar("expected_action", { length: 20 }),
		actualAction: varchar("actual_action", { length: 20 }),
		actualScore: integer("actual_score"),
		decisionId: varchar("decision_id", { length: 128 }),
		latencyMs: integer("latency_ms"),
		attempt: integer("attempt").default(1).notNull(),
		isCorrect: boolean("is_correct").notNull(),
		decision: jsonb("decision").$type<Record<string, unknown>>().default({}),
		findings: jsonb("findings").$type<Array<{
			dimension: string;
			dimensionName: string;
			score: number;
			action: string;
			reason: string;
		}>>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("evaluation_results_run_id_idx").on(table.runId),
		index("evaluation_results_test_case_id_idx").on(table.testCaseId),
		uniqueIndex("evaluation_results_scope_run_case_attempt_uq").on(
			table.tenantId,
			table.applicationId,
			table.runId,
			table.testCaseId,
			table.attempt,
		),
	]
);

// ============================================
// 22. 用户策略状态表（策略升级功能）
// ============================================
export const userPolicyStates = pgTable(
	"user_policy_states",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		userId: varchar("user_id", { length: 100 }).notNull(),
		sessionId: varchar("session_id", { length: 100 }).notNull(), // 浏览器会话ID
		originalPolicyId: varchar("original_policy_id", { length: 36 }).notNull().references(() => policyProfiles.id), // 原始策略
		currentPolicyId: varchar("current_policy_id", { length: 36 }).notNull().references(() => policyProfiles.id), // 当前生效策略
		consecutiveWarningCount: integer("consecutive_warning_count").default(0).notNull(), // 连续警告计数
		consecutiveAllowCount: integer("consecutive_allow_count").default(0).notNull(), // 连续放行计数（用于降级）
		isEscalated: boolean("is_escalated").default(false).notNull(), // 是否已升级
		escalatedAt: timestamp("escalated_at", { withTimezone: true }), // 升级时间
		lastDetectionAction: varchar("last_detection_action", { length: 20 }), // 最近一次检测动作
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("user_policy_states_user_id_idx").on(table.userId),
		index("user_policy_states_session_id_idx").on(table.sessionId),
		index("user_policy_states_current_policy_id_idx").on(table.currentPolicyId),
	]
);

// ============================================
// 23. 不可变策略包与应用激活指针
// ============================================
export const policyBundles = pgTable(
	"policy_bundles",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		policyId: varchar("policy_id", { length: 36 }).notNull().references(() => policyProfiles.id, { onDelete: "restrict" }),
		version: integer("version").notNull(),
		state: varchar("state", { length: 32 }).notNull().default("draft"),
		canonicalJson: jsonb("canonical_json").$type<Record<string, unknown>>().notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		signature: text("signature").notNull(),
		signatureAlgorithm: varchar("signature_algorithm", { length: 32 }).notNull().default("Ed25519"),
		signingKeyId: varchar("signing_key_id", { length: 128 }).notNull(),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		approvedBy: varchar("approved_by", { length: 100 }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		testedBy: varchar("tested_by", { length: 100 }),
		testedAt: timestamp("tested_at", { withTimezone: true }),
		testEvidenceId: varchar("test_evidence_id", { length: 36 }).references(() => evaluationRuns.id, { onDelete: "restrict" }),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
		archivedBy: varchar("archived_by", { length: 100 }),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		lifecycleVersion: integer("lifecycle_version").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("policy_bundles_scope_policy_version_uq").on(
			table.tenantId,
			table.applicationId,
			table.policyId,
			table.version,
		),
		uniqueIndex("policy_bundles_scope_id_uq").on(
			table.tenantId,
			table.applicationId,
			table.id,
		),
		index("policy_bundles_scope_state_idx").on(
			table.tenantId,
			table.applicationId,
			table.state,
		),
	]
);

export const policyBundleTransitions = pgTable(
	"policy_bundle_transitions",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		bundleId: varchar("bundle_id", { length: 36 }).notNull().references(() => policyBundles.id, { onDelete: "restrict" }),
		fromState: varchar("from_state", { length: 32 }),
		toState: varchar("to_state", { length: 32 }).notNull(),
		action: varchar("action", { length: 32 }).notNull(),
		actorId: varchar("actor_id", { length: 100 }).notNull(),
		reason: varchar("reason", { length: 500 }),
		evidenceId: varchar("evidence_id", { length: 100 }),
		lifecycleVersion: integer("lifecycle_version").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("policy_bundle_transitions_version_uq").on(table.bundleId, table.lifecycleVersion),
		index("policy_bundle_transitions_scope_created_idx").on(table.tenantId, table.applicationId, table.createdAt),
	]
);

export const guardSessionRequestReceipts = pgTable('guard_session_request_receipts', {
  ...tenantScopeColumns(),
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar('session_id',{length:128}).notNull(),
  requestId: varchar('request_id',{length:128}).notNull(),
  direction: varchar('direction',{length:32}).notNull(),
  requestHmac: varchar('request_hmac',{length:64}).notNull(),
  keyId: varchar('key_id',{length:128}).notNull(),
  decisionEnvelopes: jsonb('decision_envelopes').$type<import('@/lib/secrets').SecretEnvelope[]>().notNull(),
  eventId: uuid('event_id').notNull(),
  stateVersion: integer('state_version').notNull(),
  sequenceNumber: bigint('sequence_number',{mode:'number'}).notNull(),
  expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[
  uniqueIndex('guard_session_receipts_request_uq').on(table.tenantId,table.applicationId,table.sessionId,table.requestId,table.direction),
  index('guard_session_receipts_expiry_idx').on(table.expiresAt),
]);

export const guardSessionRiskStates = pgTable(
	"guard_session_risk_states",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		sessionId: varchar("session_id", { length: 128 }).notNull(),
		tailEnvelope: jsonb("tail_envelope").$type<{
			keyId: string;
			algorithm: "AES-256-GCM";
			iv: string;
			ciphertext: string;
			authTag: string;
		}>().notNull(),
		hotWindowTokenCount: integer("hot_window_token_count").notNull().default(0),
		tokenizerId: varchar("tokenizer_id", { length: 256 }),
		lastEventSequence: bigint("last_event_sequence", { mode: "number" }).notNull().default(0),
		turnCount: integer("turn_count").notNull().default(1),
		stateVersion: integer("state_version").notNull().default(1),
		riskVector: jsonb("risk_vector").$type<Record<string, number>>().notNull().default({}),
		recentRiskTypes: jsonb("recent_risk_types").$type<string[]>().notNull().default([]),
		escalationLevel: integer("escalation_level").notNull().default(0),
		lastRequestId: varchar("last_request_id", { length: 128 }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_session_risk_states_scope_session_uq")
			.on(table.tenantId, table.applicationId, table.sessionId),
		index("guard_session_risk_states_expires_idx").on(table.expiresAt),
	]
);

export const guardMemoryEvents = pgTable(
	"guard_memory_events",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		sessionId: varchar("session_id", { length: 128 }).notNull(),
		sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull(),
		eventType: varchar("event_type", { length: 40 }).notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		payloadEnvelopes: jsonb("payload_envelopes").$type<Array<{
			keyId: string;
			algorithm: "AES-256-GCM";
			iv: string;
			ciphertext: string;
			authTag: string;
		}>>().notNull(),
		sourceEnvelopeIds: jsonb("source_envelope_ids").$type<string[]>().notNull().default([]),
		parentEventIds: jsonb("parent_event_ids").$type<string[]>().notNull().default([]),
		sensitivityLabels: jsonb("sensitivity_labels").$type<string[]>().notNull().default([]),
		riskLabels: jsonb("risk_labels").$type<string[]>().notNull().default([]),
		policyBundleId: varchar("policy_bundle_id", { length: 36 }).notNull(),
		decisionId: varchar("decision_id", { length: 128 }).notNull(),
		tokenizerId: varchar("tokenizer_id", { length: 256 }),
		tokenCount: integer("token_count"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_memory_events_scope_sequence_uq")
			.on(table.tenantId, table.applicationId, table.sessionId, table.sequenceNumber),
		index("guard_memory_events_scope_session_idx")
			.on(table.tenantId, table.applicationId, table.sessionId, table.createdAt),
		index("guard_memory_events_expires_idx").on(table.expiresAt),
	]
);

export const guardMemoryRiskLedgers = pgTable(
	"guard_memory_risk_ledgers",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		sessionId: varchar("session_id", { length: 128 }).notNull(),
		stateVersion: integer("state_version").notNull().default(1),
		riskState: varchar("risk_state", { length: 24 }).notNull().default("NORMAL"),
		maxRiskLevel: varchar("max_risk_level", { length: 20 }).notNull().default("NONE"),
		cumulativeScore: integer("cumulative_score").notNull().default(0),
		entries: jsonb("entries").$type<Array<{
			riskType: string;
			maxScore: number;
			occurrences: number;
			lastAction: string;
			firstSeenAt: string;
			lastSeenAt: string;
			evidenceHmacs: string[];
		}>>().notNull().default([]),
		intentNodes: jsonb("intent_nodes").$type<Array<{
			id: string;
			occurredAt: string;
			lastDecayedAt: string;
			phases: string[];
			riskTypes: string[];
			decayedScore: number;
			sources: string[];
			evidenceHmacs: string[];
			action: string;
		}>>().notNull().default([]),
		stateTransitions: jsonb("state_transitions").$type<Array<{
			from: string;
			to: string;
			reasonCode: string;
			occurredAt: string;
		}>>().notNull().default([]),
		sensitivityLabels: jsonb("sensitivity_labels").$type<string[]>().notNull().default([]),
		sourceEnvelopeIds: jsonb("source_envelope_ids").$type<string[]>().notNull().default([]),
		lastDecisionId: varchar("last_decision_id", { length: 128 }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_memory_risk_ledgers_scope_session_uq")
			.on(table.tenantId, table.applicationId, table.sessionId),
		index("guard_memory_risk_ledgers_expires_idx").on(table.expiresAt),
	]
);

export const guardMemoryGraphEdges = pgTable(
	"guard_memory_graph_edges",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		sessionId: varchar("session_id", { length: 128 }).notNull(),
		fromNodeType: varchar("from_node_type", { length: 32 }).notNull(),
		fromNodeId: varchar("from_node_id", { length: 128 }).notNull(),
		toNodeType: varchar("to_node_type", { length: 32 }).notNull(),
		toNodeId: varchar("to_node_id", { length: 128 }).notNull(),
		relation: varchar("relation", { length: 48 }).notNull(),
		riskLabels: jsonb("risk_labels").$type<string[]>().notNull().default([]),
		evidenceHmac: varchar("evidence_hmac", { length: 64 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_memory_graph_edges_identity_uq").on(
			table.tenantId,
			table.applicationId,
			table.sessionId,
			table.fromNodeType,
			table.fromNodeId,
			table.toNodeType,
			table.toNodeId,
			table.relation,
		),
		index("guard_memory_graph_edges_scope_session_idx")
			.on(table.tenantId, table.applicationId, table.sessionId),
	]
);

export const applicationPolicyBindings = pgTable(
	"application_policy_bindings",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		activeBundleId: varchar("active_bundle_id", { length: 36 }).references(() => policyBundles.id, { onDelete: "restrict" }),
		shadowBundleId: varchar("shadow_bundle_id", { length: 36 }).references(() => policyBundles.id, { onDelete: "restrict" }),
		canaryBundleId: varchar("canary_bundle_id", { length: 36 }).references(() => policyBundles.id, { onDelete: "restrict" }),
		previousBundleId: varchar("previous_bundle_id", { length: 36 }).references(() => policyBundles.id, { onDelete: "restrict" }),
		canaryPercent: integer("canary_percent").notNull().default(0),
		generation: integer("generation").notNull().default(0),
		updatedBy: varchar("updated_by", { length: 100 }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("application_policy_bindings_scope_uq").on(
			table.tenantId,
			table.applicationId,
		),
	]
);

export const applicationRoutingConfigs = pgTable(
	"application_routing_configs",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		mode: varchar("mode", { length: 20 }).notNull().default("legacy"),
		guardPercent: integer("guard_percent").notNull().default(0),
		generation: integer("generation").notNull().default(0),
		previousConfig: jsonb("previous_config").$type<{
			mode: string;
			guardPercent: number;
		}>(),
		updatedBy: varchar("updated_by", { length: 100 }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("application_routing_configs_scope_uq").on(table.tenantId, table.applicationId),
	]
);

export const artifacts = pgTable(
	"artifacts",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		ownerId: varchar("owner_id", { length: 100 }).notNull(),
		kind: varchar("kind", { length: 24 }).notNull(),
		fileName: varchar("file_name", { length: 500 }).notNull(),
		declaredMediaType: varchar("declared_media_type", { length: 200 }).notNull(),
		detectedMediaType: varchar("detected_media_type", { length: 200 }),
		declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
		verifiedSize: bigint("verified_size", { mode: "number" }),
		declaredSha256: varchar("declared_sha256", { length: 64 }).notNull(),
		verifiedSha256: varchar("verified_sha256", { length: 64 }),
		objectPrefix: varchar("object_prefix", { length: 800 }).notNull(),
		state: varchar("state", { length: 24 }).notNull().default("uploading"),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		partSize: integer("part_size").notNull(),
		partCount: integer("part_count").notNull(),
		failureCode: varchar("failure_code", { length: 100 }),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
		contentExpiresAt: timestamp("content_expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("artifacts_scope_idempotency_uq").on(table.tenantId, table.applicationId, table.idempotencyKey),
		uniqueIndex("artifacts_scope_id_uq").on(table.tenantId, table.applicationId, table.id),
		index("artifacts_scope_state_idx").on(table.tenantId, table.applicationId, table.state),
		index("artifacts_expires_at_idx").on(table.contentExpiresAt),
	]
);

export const artifactParts = pgTable(
	"artifact_parts",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		artifactId: varchar("artifact_id", { length: 128 }).notNull(),
		partNumber: integer("part_number").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: varchar("sha256", { length: 64 }).notNull(),
		etag: varchar("etag", { length: 200 }),
		objectKey: varchar("object_key", { length: 900 }).notNull(),
		state: varchar("state", { length: 20 }).notNull().default("declared"),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("artifact_parts_scope_number_uq").on(
			table.tenantId, table.applicationId, table.artifactId, table.partNumber,
		),
		index("artifact_parts_artifact_idx").on(table.artifactId),
	]
);

export const guardJobs = pgTable(
	"guard_jobs",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		ownerId: varchar("owner_id", { length: 100 }).notNull(),
		artifactId: varchar("artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "restrict" }),
		contextArtifactId: varchar("context_artifact_id", { length: 36 }).references(() => artifacts.id, { onDelete: "restrict" }),
		bundleId: varchar("bundle_id", { length: 36 }).notNull().references(() => policyBundles.id, { onDelete: "restrict" }),
		jobType: varchar("job_type", { length: 32 }).notNull(),
		status: varchar("status", { length: 24 }).notNull().default("pending"),
		stage: varchar("stage", { length: 64 }).notNull().default("queued"),
		progress: integer("progress").notNull().default(0),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		attempt: integer("attempt").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		failureHistory: jsonb("failure_history").$type<Array<Record<string, unknown>>>().default([]).notNull(),
		result: jsonb("result").$type<Record<string, unknown>>().default({}),
		callbackUrl: varchar("callback_url", { length: 1000 }),
		callbackSecretRef: varchar("callback_secret_ref", { length: 100 }),
		callbackState: varchar("callback_state", { length: 24 }).default("not_requested"),
		callbackAttempt: integer("callback_attempt").notNull().default(0),
		callbackNextAt: timestamp("callback_next_at", { withTimezone: true }),
		callbackLastError: varchar("callback_last_error", { length: 500 }),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("guard_jobs_scope_idempotency_uq").on(table.tenantId, table.applicationId, table.idempotencyKey),
		uniqueIndex("guard_jobs_scope_id_uq").on(table.tenantId, table.applicationId, table.id),
		index("guard_jobs_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
		index("guard_jobs_artifact_idx").on(table.artifactId),
	]
);

export const guardJobEvents = pgTable(
	"guard_job_events",
	{
		...tenantScopeColumns(),
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		jobId: varchar("job_id", { length: 36 }).notNull().references(() => guardJobs.id, { onDelete: "cascade" }),
		eventType: varchar("event_type", { length: 64 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("guard_job_events_job_idx").on(table.jobId, table.createdAt)]
);

export const artifactDerivatives = pgTable(
	"artifact_derivatives",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		artifactId: varchar("artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "cascade" }),
		parentArtifactId: varchar("parent_artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "cascade" }),
		viewId: varchar("view_id", { length: 100 }).notNull(),
		transform: varchar("transform", { length: 100 }).notNull(),
		parameters: jsonb("parameters").$type<Record<string, unknown>>().default({}),
		coordinateMapping: jsonb("coordinate_mapping").$type<Record<string, unknown>>().default({}),
		sha256: varchar("sha256", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("artifact_derivatives_scope_view_uq").on(table.tenantId, table.applicationId, table.parentArtifactId, table.viewId),
		index("artifact_derivatives_parent_idx").on(table.parentArtifactId),
	]
);

export const generatedContentDerivatives = pgTable(
	"generated_content_derivatives",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		contentMarkId: uuid("content_mark_id").notNull()
			.references(() => generatedContentMarks.id, { onDelete: "restrict" }),
		sourceArtifactId: varchar("source_artifact_id", { length: 36 }).notNull()
			.references(() => artifacts.id, { onDelete: "restrict" }),
		outputObjectKey: varchar("output_object_key", { length: 900 }).notNull(),
		mediaType: varchar("media_type", { length: 128 }).notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		sha256: varchar("sha256", { length: 64 }).notNull(),
		visibleMarkApplied: boolean("visible_mark_applied").notNull(),
		spokenMarkApplied: boolean("spoken_mark_applied").notNull(),
		metadataEmbedded: boolean("metadata_embedded").notNull(),
		analyzerVersion: varchar("analyzer_version", { length: 100 }).notNull(),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("generated_content_derivatives_scope_mark_uq").on(
			table.tenantId, table.applicationId, table.contentMarkId,
		),
		uniqueIndex("generated_content_derivatives_scope_object_uq").on(
			table.tenantId, table.applicationId, table.outputObjectKey,
		),
		index("generated_content_derivatives_source_idx").on(
			table.tenantId, table.applicationId, table.sourceArtifactId,
		),
	]
);

export const dataLineageEdges = pgTable(
	"data_lineage_edges",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		sourceType: varchar("source_type", { length: 64 }).notNull(),
		sourceId: varchar("source_id", { length: 256 }).notNull(),
		targetType: varchar("target_type", { length: 64 }).notNull(),
		targetId: varchar("target_id", { length: 256 }).notNull(),
		operation: varchar("operation", { length: 64 }).notNull(),
		processorId: varchar("processor_id", { length: 256 }).notNull(),
		processorVersion: varchar("processor_version", { length: 256 }).notNull(),
		attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
		evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("data_lineage_edges_identity_uq").on(
			table.tenantId, table.applicationId, table.sourceType, table.sourceId,
			table.targetType, table.targetId, table.operation, table.processorId,
		),
		index("data_lineage_edges_source_idx").on(
			table.tenantId, table.applicationId, table.sourceType, table.sourceId,
		),
		index("data_lineage_edges_target_idx").on(
			table.tenantId, table.applicationId, table.targetType, table.targetId,
		),
	]
);

export const dataDeletionProofs = pgTable(
	"data_deletion_proofs",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		proofId: uuid("proof_id").notNull().unique(),
		version: varchar("version", { length: 16 }).notNull(),
		cutoff: timestamp("cutoff", { withTimezone: true }).notNull(),
		manifest: jsonb("manifest").$type<Array<{
			objectType: string;
			count: number;
			idDigest: string;
		}>>().notNull(),
		phases: jsonb("phases").$type<Record<string, {
			state: "COMPLETE" | "NOT_APPLICABLE" | "PENDING_EXTERNAL";
			evidence?: string;
		}>>().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
		keyId: varchar("key_id", { length: 64 }).notNull(),
		signature: varchar("signature", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("data_deletion_proofs_cutoff_idx").on(table.cutoff),
		index("data_deletion_proofs_completed_idx").on(table.completedAt),
	]
);

export const multimodalFindings = pgTable(
	"multimodal_findings",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		jobId: varchar("job_id", { length: 36 }).notNull().references(() => guardJobs.id, { onDelete: "cascade" }),
		riskType: varchar("risk_type", { length: 128 }).notNull(),
		score: integer("score").notNull(),
		action: varchar("action", { length: 32 }).notNull(),
		cooperativeAttack: boolean("cooperative_attack").notNull().default(false),
		evidence: jsonb("evidence").$type<Array<Record<string, unknown>>>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("multimodal_findings_job_idx").on(table.jobId)]
);

export const mediaTimelineFindings = pgTable(
	"media_timeline_findings",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		jobId: varchar("job_id", { length: 36 }).notNull().references(() => guardJobs.id, { onDelete: "cascade" }),
		riskType: varchar("risk_type", { length: 128 }).notNull(),
		score: integer("score").notNull(),
		action: varchar("action", { length: 32 }).notNull(),
		startMs: bigint("start_ms", { mode: "number" }),
		endMs: bigint("end_ms", { mode: "number" }),
		frameIndex: integer("frame_index"),
		region: jsonb("region").$type<readonly [number, number, number, number]>(),
		contentHmac: varchar("content_hmac", { length: 64 }),
		reasonCode: varchar("reason_code", { length: 128 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("media_timeline_findings_job_time_idx").on(table.jobId, table.startMs)]
);

export const ragSources = pgTable(
	"rag_sources",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		artifactId: varchar("artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "restrict" }),
		sourceUriHash: varchar("source_uri_hash", { length: 64 }).notNull(),
		sourceType: varchar("source_type", { length: 64 }).notNull(),
		trustLevel: integer("trust_level").notNull().default(0),
		classification: integer("classification").notNull().default(0),
		acl: jsonb("acl").$type<{ allowedPrincipals?: string[]; allowedRoles?: string[] }>().default({}),
		state: varchar("state", { length: 24 }).notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("rag_sources_scope_artifact_uq").on(table.tenantId, table.applicationId, table.artifactId),
		index("rag_sources_scope_state_idx").on(table.tenantId, table.applicationId, table.state),
	]
);

export const ragChunks = pgTable(
	"rag_chunks",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		sourceId: varchar("source_id", { length: 36 }).notNull().references(() => ragSources.id, { onDelete: "cascade" }),
		artifactId: varchar("artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "restrict" }),
		externalChunkId: varchar("external_chunk_id", { length: 256 }).notNull(),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		provenanceSignature: varchar("provenance_signature", { length: 128 }).notNull(),
		riskAction: varchar("risk_action", { length: 32 }).notNull(),
		riskScore: integer("risk_score").notNull(),
		state: varchar("state", { length: 24 }).notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("rag_chunks_scope_external_uq").on(table.tenantId, table.applicationId, table.externalChunkId),
		index("rag_chunks_source_idx").on(table.sourceId),
		index("rag_chunks_scope_state_idx").on(table.tenantId, table.applicationId, table.state),
	]
);

export const ragRetrievalAudits = pgTable(
	"rag_retrieval_audits",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		principalId: varchar("principal_id", { length: 100 }).notNull(),
		traceId: varchar("trace_id", { length: 128 }).notNull(),
		queryHash: varchar("query_hash", { length: 64 }).notNull(),
		candidateCount: integer("candidate_count").notNull(),
		acceptedCount: integer("accepted_count").notNull(),
		rejected: jsonb("rejected").$type<Array<{ chunkId: string; code: string }>>().default([]),
		tainted: boolean("tainted").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("rag_retrieval_audits_trace_idx").on(table.traceId)]
);

export const toolRegistry = pgTable(
	"tool_registry",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 200 }).notNull(),
		version: varchar("version", { length: 64 }).notNull(),
		kind: varchar("kind", { length: 16 }).notNull(),
		endpoint: varchar("endpoint", { length: 1000 }),
		serverIdentity: varchar("server_identity", { length: 500 }),
		allowedRoles: jsonb("allowed_roles").$type<string[]>().default([]),
		allowedActions: jsonb("allowed_actions").$type<string[]>().default([]),
		resourcePatterns: jsonb("resource_patterns").$type<string[]>().default([]),
		parameterPolicy: jsonb("parameter_policy").$type<{
			required?: string[];
			allowedKeys?: string[];
			maxStringLength?: number;
			enums?: Record<string, Array<string | number | boolean | null>>;
		}>().default({}),
		sideEffect: varchar("side_effect", { length: 32 }).notNull().default("READ"),
		requiredPermissions: jsonb("required_permissions").$type<string[]>().notNull().default([]),
		allowedDataDestinations: jsonb("allowed_data_destinations").$type<string[]>().notNull().default([]),
		definitionDigest: varchar("definition_digest", { length: 64 }),
		sourceUri: varchar("source_uri", { length: 2048 }),
		sourceDigest: varchar("source_digest", { length: 71 }),
		signatureKeyId: varchar("signature_key_id", { length: 128 }),
		signature: text("signature"),
		licenseSpdx: varchar("license_spdx", { length: 128 }),
		noticeDigest: varchar("notice_digest", { length: 71 }),
		scannerDefinitionDigest: varchar("scanner_definition_digest", { length: 71 }),
		networkDomains: jsonb("network_domains").$type<string[]>().notNull().default([]),
		filePaths: jsonb("file_paths").$type<string[]>().notNull().default([]),
		commands: jsonb("commands").$type<string[]>().notNull().default([]),
		credentialRefs: jsonb("credential_refs").$type<string[]>().notNull().default([]),
		approvalIds: jsonb("approval_ids").$type<string[]>().notNull().default([]),
		isolatedDynamicAnalysis: boolean("isolated_dynamic_analysis").notNull().default(false),
		highRisk: boolean("high_risk").notNull().default(false),
		approvalRequired: boolean("approval_required").notNull().default(false),
		resultGuardRequired: boolean("result_guard_required").notNull().default(true),
		status: varchar("status", { length: 20 }).notNull().default("active"),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("tool_registry_scope_name_version_uq").on(table.tenantId, table.applicationId, table.name, table.version),
		uniqueIndex("tool_registry_scope_id_uq").on(table.tenantId, table.applicationId, table.id),
		index("tool_registry_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
		index("tool_registry_source_digest_idx").on(table.sourceDigest),
	]
);

export const toolInvocations = pgTable(
	"tool_invocations",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		requestId: varchar("request_id", { length: 128 }).notNull(),
		traceId: varchar("trace_id", { length: 128 }).notNull(),
		principalId: varchar("principal_id", { length: 100 }).notNull(),
		agentRunId: varchar("agent_run_id", { length: 128 }),
		toolId: varchar("tool_id", { length: 36 }).notNull().references(() => toolRegistry.id, { onDelete: "restrict" }),
		toolVersion: varchar("tool_version", { length: 64 }),
		bundleId: varchar("bundle_id", { length: 36 }).notNull().references(() => policyBundles.id, { onDelete: "restrict" }),
		action: varchar("action", { length: 128 }).notNull(),
		resource: varchar("resource", { length: 1000 }).notNull(),
		parametersHash: varchar("parameters_hash", { length: 64 }).notNull(),
		actionIntentHash: varchar("action_intent_hash", { length: 64 }),
		actionIntent: jsonb("action_intent").$type<Record<string, unknown>>(),
		sideEffect: varchar("side_effect", { length: 32 }),
		riskCost: integer("risk_cost").notNull().default(0),
		riskBudget: integer("risk_budget").notNull().default(0),
		supportingEnvelopeIds: jsonb("supporting_envelope_ids").$type<string[]>().notNull().default([]),
		dataDestinations: jsonb("data_destinations").$type<string[]>().notNull().default([]),
		repairSuggestion: jsonb("repair_suggestion").$type<Record<string, unknown>>(),
		approvalDecisionId: varchar("approval_decision_id", { length: 36 }),
		contextTainted: boolean("context_tainted").notNull().default(false),
		status: varchar("status", { length: 32 }).notNull(),
		permitExpiresAt: timestamp("permit_expires_at", { withTimezone: true }),
		permitConsumedAt: timestamp("permit_consumed_at", { withTimezone: true }),
		resultDecision: jsonb("result_decision").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("tool_invocations_scope_request_uq").on(table.tenantId, table.applicationId, table.requestId),
		uniqueIndex("tool_invocations_scope_id_uq").on(table.tenantId, table.applicationId, table.id),
		index("tool_invocations_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
	]
);

export const agentLifecycleBudgets = pgTable(
	"agent_lifecycle_budgets",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		agentRunId: varchar("agent_run_id", { length: 128 }).notNull(),
		principalId: varchar("principal_id", { length: 100 }).notNull(),
		allocatedRiskBudget: integer("allocated_risk_budget").notNull(),
		consumedRiskBudget: integer("consumed_risk_budget").notNull().default(0),
		toolSteps: integer("tool_steps").notNull().default(0),
		maximumToolSteps: integer("maximum_tool_steps").notNull().default(32),
		recursionDepth: integer("recursion_depth").notNull().default(0),
		maximumRecursionDepth: integer("maximum_recursion_depth").notNull().default(8),
		browserTabs: integer("browser_tabs").notNull().default(0),
		maximumBrowserTabs: integer("maximum_browser_tabs").notNull().default(8),
		processes: integer("processes").notNull().default(0),
		maximumProcesses: integer("maximum_processes").notNull().default(4),
		connections: integer("connections").notNull().default(0),
		maximumConnections: integer("maximum_connections").notNull().default(16),
		files: integer("files").notNull().default(0),
		maximumFiles: integer("maximum_files").notNull().default(100),
		ocrPages: integer("ocr_pages").notNull().default(0),
		maximumOcrPages: integer("maximum_ocr_pages").notNull().default(500),
		mediaDurationSeconds: integer("media_duration_seconds").notNull().default(0),
		maximumMediaDurationSeconds: integer("maximum_media_duration_seconds").notNull().default(3600),
		mediaFrames: integer("media_frames").notNull().default(0),
		maximumMediaFrames: integer("maximum_media_frames").notNull().default(10000),
		decodingBranches: integer("decoding_branches").notNull().default(0),
		maximumDecodingBranches: integer("maximum_decoding_branches").notNull().default(64),
		judgeCalls: integer("judge_calls").notNull().default(0),
		maximumJudgeCalls: integer("maximum_judge_calls").notNull().default(32),
		decompressedBytes: bigint("decompressed_bytes", { mode: "number" }).notNull().default(0),
		maximumDecompressedBytes: bigint("maximum_decompressed_bytes", { mode: "number" }).notNull().default(1073741824),
		guardInferenceTokens: integer("guard_inference_tokens").notNull().default(0),
		maximumGuardInferenceTokens: integer("maximum_guard_inference_tokens").notNull().default(1000000),
		state: varchar("state", { length: 24 }).notNull().default("ACTIVE"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("agent_lifecycle_budgets_scope_run_uq")
			.on(table.tenantId, table.applicationId, table.agentRunId),
		index("agent_lifecycle_budgets_expires_idx").on(table.expiresAt),
	]
);

export const toolApprovals = pgTable(
	"tool_approvals",
	{
		...tenantScopeColumns(),
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		invocationId: varchar("invocation_id", { length: 36 }).notNull().references(() => toolInvocations.id, { onDelete: "cascade" }),
		requesterId: varchar("requester_id", { length: 100 }).notNull(),
		approverId: varchar("approver_id", { length: 100 }),
		status: varchar("status", { length: 20 }).notNull().default("pending"),
		reason: varchar("reason", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("tool_approvals_scope_invocation_uq").on(table.tenantId, table.applicationId, table.invocationId),
		index("tool_approvals_scope_status_idx").on(table.tenantId, table.applicationId, table.status),
	]
);

export const operationalSecurityEvents = pgTable(
	"operational_security_events",
	{
		id: uuid("id").notNull().defaultRandom(),
		domain: varchar("domain", { length: 32 }).notNull(),
		eventType: varchar("event_type", { length: 128 }).notNull(),
		severity: varchar("severity", { length: 16 }).notNull(),
		outcome: varchar("outcome", { length: 32 }).notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		tenantId: varchar("tenant_id", { length: 100 }),
		applicationId: varchar("application_id", { length: 100 }),
		principalId: varchar("principal_id", { length: 100 }),
		traceId: varchar("trace_id", { length: 128 }),
		requestId: varchar("request_id", { length: 128 }),
		action: varchar("action", { length: 64 }),
		source: varchar("source", { length: 128 }).notNull(),
		network: jsonb("network").$type<Record<string, unknown>>(),
		model: jsonb("model").$type<Record<string, unknown>>(),
		evidenceDigest: varchar("evidence_digest", { length: 64 }).notNull(),
		contentHmac: varchar("content_hmac", { length: 64 }),
		attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("operational_security_events_time_id_uq").on(table.occurredAt, table.id),
		index("operational_security_events_scope_time_idx")
			.on(table.tenantId, table.applicationId, table.occurredAt),
		index("operational_security_events_domain_time_idx").on(table.domain, table.occurredAt),
	]
);

export const securityScanAssets = pgTable(
	"security_scan_assets",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		targetType: varchar("target_type", { length: 32 }).notNull(),
		externalInventoryId: varchar("external_inventory_id", { length: 256 }).notNull(),
		version: varchar("version", { length: 256 }).notNull(),
		sha256: varchar("sha256", { length: 71 }),
		status: varchar("status", { length: 16 }).notNull().default("ACTIVE"),
		createdBy: varchar("created_by", { length: 100 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("security_scan_assets_scope_external_version_uq").on(
			table.tenantId,
			table.applicationId,
			table.targetType,
			table.externalInventoryId,
			table.version,
		),
		index("security_scan_assets_scope_status_idx")
			.on(table.tenantId, table.applicationId, table.status),
	]
);

export const securityScanTasks = pgTable(
	"security_scan_tasks",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		assetId: uuid("asset_id").notNull()
			.references(() => securityScanAssets.id, { onDelete: "restrict" }),
		scannerId: varchar("scanner_id", { length: 128 }).notNull(),
		scanKind: varchar("scan_kind", { length: 32 }).notNull(),
		targetType: varchar("target_type", { length: 32 }).notNull(),
		targetInventoryId: varchar("target_inventory_id", { length: 256 }).notNull(),
		targetVersion: varchar("target_version", { length: 256 }).notNull(),
		targetSha256: varchar("target_sha256", { length: 71 }),
		scannerDefinitionDigest: varchar("scanner_definition_digest", { length: 71 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		submittedBy: varchar("submitted_by", { length: 100 }).notNull(),
		status: varchar("status", { length: 24 }).notNull().default("QUEUED"),
		attempt: integer("attempt").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		failureHistory: jsonb("failure_history").$type<Array<{
			attempt: number;
			at: string;
			code: string;
			message: string;
		}>>().notNull().default([]),
		resultDigest: varchar("result_digest", { length: 71 }),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("security_scan_tasks_scope_idempotency_uq")
			.on(table.tenantId, table.applicationId, table.idempotencyKey),
		index("security_scan_tasks_scope_status_idx")
			.on(table.tenantId, table.applicationId, table.status),
		index("security_scan_tasks_status_created_idx").on(table.status, table.createdAt),
	]
);

export const securityScanAttempts = pgTable(
	"security_scan_attempts",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		taskId: uuid("task_id").notNull()
			.references(() => securityScanTasks.id, { onDelete: "cascade" }),
		attempt: integer("attempt").notNull(),
		status: varchar("status", { length: 24 }).notNull(),
		scannerId: varchar("scanner_id", { length: 128 }).notNull(),
		scannerVersion: varchar("scanner_version", { length: 256 }),
		scannerDigest: varchar("scanner_digest", { length: 71 }),
		rawOutputDigest: varchar("raw_output_digest", { length: 71 }),
		errorCode: varchar("error_code", { length: 128 }),
		errorMessage: varchar("error_message", { length: 500 }),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("security_scan_attempts_scope_task_attempt_uq")
			.on(table.tenantId, table.applicationId, table.taskId, table.attempt),
		index("security_scan_attempts_task_idx").on(table.taskId),
	]
);

export const securityScanFindings = pgTable(
	"security_scan_findings",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		taskId: uuid("task_id").notNull()
			.references(() => securityScanTasks.id, { onDelete: "cascade" }),
		fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
		ruleId: varchar("rule_id", { length: 256 }).notNull(),
		category: varchar("category", { length: 128 }).notNull(),
		severity: varchar("severity", { length: 16 }).notNull(),
		title: varchar("title", { length: 500 }).notNull(),
		evidenceDigest: varchar("evidence_digest", { length: 71 }).notNull(),
		remediation: text("remediation"),
		disposition: varchar("disposition", { length: 32 }).notNull().default("UNREVIEWED"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("security_scan_findings_scope_task_fingerprint_uq")
			.on(table.tenantId, table.applicationId, table.taskId, table.fingerprint),
		index("security_scan_findings_task_idx").on(table.taskId),
		index("security_scan_findings_scope_severity_idx")
			.on(table.tenantId, table.applicationId, table.severity),
	]
);

export const securityScanFindingReviews = pgTable(
	"security_scan_finding_reviews",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		findingId: uuid("finding_id").notNull()
			.references(() => securityScanFindings.id, { onDelete: "cascade" }),
		reviewerId: varchar("reviewer_id", { length: 100 }).notNull(),
		disposition: varchar("disposition", { length: 32 }).notNull(),
		reason: varchar("reason", { length: 1000 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("security_scan_reviews_scope_finding_reviewer_uq")
			.on(table.tenantId, table.applicationId, table.findingId, table.reviewerId),
		index("security_scan_reviews_finding_idx").on(table.findingId),
	]
);

export const guardQuotaCounters = pgTable(
	"guard_quota_counters",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		policyBundleId: varchar("policy_bundle_id", { length: 36 }).notNull(),
		scopeType: varchar("scope_type", { length: 24 }).notNull(),
		scopeId: varchar("scope_id", { length: 256 }).notNull(),
		metric: varchar("metric", { length: 32 }).notNull(),
		window: varchar("window", { length: 16 }).notNull(),
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
		used: bigint("used", { mode: "number" }).notNull().default(0),
		limitValue: bigint("limit_value", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_quota_counters_identity_window_uq").on(
			table.tenantId,
			table.applicationId,
			table.policyBundleId,
			table.scopeType,
			table.scopeId,
			table.metric,
			table.window,
			table.windowStart,
		),
		index("guard_quota_counters_expiry_idx").on(table.windowEnd),
	]
);

export const guardQuotaCharges = pgTable(
	"guard_quota_charges",
	{
		...tenantScopeColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		counterId: uuid("counter_id").notNull()
			.references(() => guardQuotaCounters.id, { onDelete: "restrict" }),
		requestId: varchar("request_id", { length: 128 }).notNull(),
		amount: bigint("amount", { mode: "number" }).notNull(),
		releaseRequired: boolean("release_required").notNull().default(false),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("guard_quota_charges_scope_counter_request_uq")
			.on(table.tenantId, table.applicationId, table.counterId, table.requestId),
		index("guard_quota_charges_expiry_idx").on(table.expiresAt, table.releasedAt),
		index("guard_quota_charges_request_idx")
			.on(table.tenantId, table.applicationId, table.requestId),
	]
);
