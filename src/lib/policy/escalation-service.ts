/**
 * 策略升级服务
 * 处理策略自动升级和降级逻辑
 */

import { db } from '@/lib/db';
import { policyProfiles, userPolicyStates } from '@/storage/database/shared/schema';
import { eq, and } from 'drizzle-orm';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

// 策略升级配置
export interface EscalationConfig {
	enabled: boolean;
	threshold: number;
	targetPolicyId: string | null;
	deescalationThreshold: number;
	cooldownMinutes: number;
}

// 用户策略状态
export interface UserPolicyState {
	id: string;
	userId: string;
	sessionId: string;
	originalPolicyId: string;
	currentPolicyId: string;
	consecutiveWarningCount: number;
	consecutiveAllowCount: number;
	isEscalated: boolean;
	escalatedAt: Date | null;
	lastDetectionAction: string | null;
}

// 策略升级结果
export interface EscalationResult {
	state: UserPolicyState | null;
	shouldEscalate: boolean;
	shouldDeescalate: boolean;
	effectivePolicyId: string;
	message: string | null;
}

/**
 * 获取策略升级配置
 */
export async function getEscalationConfig(
  scope: TenantScope,
  policyId: string,
): Promise<EscalationConfig> {
	try {
		const policies = await db
			.select()
			.from(policyProfiles)
			.where(and(
				eq(policyProfiles.id, policyId),
				scopePredicate(policyProfiles, scope),
			))
			.limit(1);

		if (policies.length === 0) {
			return getDefaultEscalationConfig();
		}

		const policy = policies[0];
		return {
			enabled: policy.escalationEnabled ?? false,
			threshold: policy.escalationThreshold ?? 5,
			targetPolicyId: policy.escalationTargetPolicyId ?? null,
			deescalationThreshold: policy.deescalationThreshold ?? 1,
			cooldownMinutes: policy.escalationCooldownMinutes ?? 30,
		};
	} catch (error) {
		console.error('[策略升级] 获取配置失败:', error);
		return getDefaultEscalationConfig();
	}
}

function getDefaultEscalationConfig(): EscalationConfig {
	return {
		enabled: false,
		threshold: 5,
		targetPolicyId: null,
		deescalationThreshold: 1,
		cooldownMinutes: 30,
	};
}

/**
 * 获取用户策略状态
 */
export async function getUserPolicyState(
	scope: TenantScope,
	userId: string,
	sessionId: string
): Promise<UserPolicyState | null> {
	try {
		const states = await db
			.select()
			.from(userPolicyStates)
			.where(
				and(
					eq(userPolicyStates.userId, userId),
					eq(userPolicyStates.sessionId, sessionId),
					scopePredicate(userPolicyStates, scope),
				)
			)
			.limit(1);

		return states.length > 0 ? states[0] as UserPolicyState : null;
	} catch (error) {
		console.error('[策略升级] 获取用户状态失败:', error);
		return null;
	}
}

/**
 * 创建用户策略状态
 */
export async function createUserPolicyState(
	scope: TenantScope,
	userId: string,
	sessionId: string,
	policyId: string
): Promise<UserPolicyState> {
	const now = new Date();
	const result = await db
		.insert(userPolicyStates)
		.values({
			tenantId: scope.tenantId,
			applicationId: scope.applicationId,
			userId,
			sessionId,
			originalPolicyId: policyId,
			currentPolicyId: policyId,
			consecutiveWarningCount: 0,
			consecutiveAllowCount: 0,
			isEscalated: false,
			escalatedAt: null,
			lastDetectionAction: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return result[0] as UserPolicyState;
}

/**
 * 更新用户策略状态
 */
export async function updateUserPolicyState(
	scope: TenantScope,
	state: Partial<UserPolicyState> & { id: string },
): Promise<void> {
	const { id, ...changes } = state;
	await db
		.update(userPolicyStates)
		.set({
			...changes,
			updatedAt: new Date(),
		})
		.where(and(
			eq(userPolicyStates.id, id),
			scopePredicate(userPolicyStates, scope),
		));
}

/**
 * 删除用户策略状态（会话重置）
 */
export async function deleteUserPolicyState(
	scope: TenantScope,
	userId: string,
	sessionId: string,
): Promise<void> {
	await db
		.delete(userPolicyStates)
		.where(
			and(
				eq(userPolicyStates.userId, userId),
				eq(userPolicyStates.sessionId, sessionId),
				scopePredicate(userPolicyStates, scope),
			)
		);
}

/**
 * 获取默认严格策略ID
 */
async function getDefaultStrictPolicyId(scope: TenantScope): Promise<string | null> {
	try {
		// 查找名称包含"严格"的策略
		const strictPolicies = await db
			.select()
			.from(policyProfiles)
			.where(and(
				eq(policyProfiles.isActive, true),
				scopePredicate(policyProfiles, scope),
			))
			.limit(10);

		// 优先查找名称包含"严格"的策略
		const strictPolicy = strictPolicies.find(
			p => p.name.toLowerCase().includes('严格') || p.name.toLowerCase().includes('strict')
		);
		if (strictPolicy) {
			return strictPolicy.id;
		}

		// 如果没有，返回非默认策略（假设默认是宽松的）
		const nonDefaultPolicy = strictPolicies.find(p => !p.isDefault);
		return nonDefaultPolicy?.id ?? null;
	} catch (error) {
		console.error('[策略升级] 获取严格策略失败:', error);
		return null;
	}
}

/**
 * 检查是否在冷却期内
 */
function isInCooldown(state: UserPolicyState, cooldownMinutes: number): boolean {
	if (!state.isEscalated || !state.escalatedAt) {
		return false;
	}
	const cooldownMs = cooldownMinutes * 60 * 1000;
	return Date.now() - state.escalatedAt.getTime() < cooldownMs;
}

/**
 * 处理一次请求的策略升级逻辑（输入+输出汇总）
 * 输入或输出有风险就加1次，输入和输出都有风险也只加1次
 */
export async function handlePolicyEscalationOnce(
	scope: TenantScope,
	userId: string,
	sessionId: string,
	hasRisk: boolean,
	originalPolicyId: string
): Promise<EscalationResult> {
	// 1. 获取策略升级配置
	const config = await getEscalationConfig(scope, originalPolicyId);

	// 如果未启用策略升级，直接返回
	if (!config.enabled) {
		return {
			state: null,
			shouldEscalate: false,
			shouldDeescalate: false,
			effectivePolicyId: originalPolicyId,
			message: null,
		};
	}

	// 2. 获取或创建用户策略状态
	let state = await getUserPolicyState(scope, userId, sessionId);
	if (!state) {
		state = await createUserPolicyState(scope, userId, sessionId, originalPolicyId);
	}

	// 3. 如果当前策略与原始策略不同（可能从其他地方修改了），重置
	if (state.currentPolicyId !== originalPolicyId && !state.isEscalated) {
		state.originalPolicyId = originalPolicyId;
		state.currentPolicyId = originalPolicyId;
		state.consecutiveWarningCount = 0;
		state.consecutiveAllowCount = 0;
	}

	let shouldEscalate = false;
	let shouldDeescalate = false;
	let message: string | null = null;
	const updates: Partial<UserPolicyState> = {};

	// 4. 根据是否有风险更新状态
	if (hasRisk) {
		// 有风险，增加警告计数，重置放行计数
		updates.consecutiveWarningCount = state.consecutiveWarningCount + 1;
		updates.consecutiveAllowCount = 0;

		console.log(`[策略升级] 检测到风险，累计警告次数: ${updates.consecutiveWarningCount}`);

		// 检查是否达到升级阈值且未升级
		if (!state.isEscalated && updates.consecutiveWarningCount >= config.threshold) {
			// 获取目标策略
			let targetPolicyId = config.targetPolicyId;
			if (!targetPolicyId) {
				targetPolicyId = await getDefaultStrictPolicyId(scope);
			}

			if (targetPolicyId) {
				updates.currentPolicyId = targetPolicyId;
				updates.isEscalated = true;
				updates.escalatedAt = new Date();
				shouldEscalate = true;
				message = '您已升级为严格策略，请文明合规使用AI';
				console.log(`[策略升级] 达到升级阈值 ${config.threshold}，升级到策略: ${targetPolicyId}`);
			}
		}
	} else {
		// 无风险，增加放行计数，重置警告计数
		updates.consecutiveAllowCount = state.consecutiveAllowCount + 1;
		updates.consecutiveWarningCount = 0;

		// 检查是否需要降级
		if (state.isEscalated) {
			// 检查是否在冷却期内
			if (!isInCooldown(state, config.cooldownMinutes)) {
				// 冷却期已过，检查放行次数是否达到降级阈值
				if (updates.consecutiveAllowCount >= config.deescalationThreshold) {
					updates.currentPolicyId = state.originalPolicyId;
					updates.isEscalated = false;
					updates.escalatedAt = null;
					updates.consecutiveAllowCount = 0;
					shouldDeescalate = true;
					message = '您已恢复宽容策略，请继续文明合规使用AI';
				}
			}
		}
	}

	// 5. 更新状态
	if (Object.keys(updates).length > 0) {
		await updateUserPolicyState(scope, { id: state.id, ...updates });
		state = { ...state, ...updates } as UserPolicyState;
	}

	return {
		state,
		shouldEscalate,
		shouldDeescalate,
		effectivePolicyId: state.currentPolicyId,
		message,
	};
}

/**
 * 处理策略升级逻辑
 */
export async function handlePolicyEscalation(
	scope: TenantScope,
	userId: string,
	sessionId: string,
	detectionAction: 'allow' | 'warn' | 'block',
	originalPolicyId: string,
	direction: 'input' | 'output' = 'input',
	hasRisk: boolean = false
): Promise<EscalationResult> {
	// 1. 获取策略升级配置
	const config = await getEscalationConfig(scope, originalPolicyId);

	// 如果未启用策略升级，直接返回
	if (!config.enabled) {
		return {
			state: null,
			shouldEscalate: false,
			shouldDeescalate: false,
			effectivePolicyId: originalPolicyId,
			message: null,
		};
	}

	// 2. 获取或创建用户策略状态
	let state = await getUserPolicyState(scope, userId, sessionId);
	if (!state) {
		state = await createUserPolicyState(scope, userId, sessionId, originalPolicyId);
	}

	// 3. 如果当前策略与原始策略不同（可能从其他地方修改了），重置
	if (state.currentPolicyId !== originalPolicyId && !state.isEscalated) {
		state.originalPolicyId = originalPolicyId;
		state.currentPolicyId = originalPolicyId;
		state.consecutiveWarningCount = 0;
		state.consecutiveAllowCount = 0;
	}

	let shouldEscalate = false;
	let shouldDeescalate = false;
	let message: string | null = null;
	const updates: Partial<UserPolicyState> = {};

	// 4. 根据检测结果更新状态
	// 只要有风险（触发了规则，即使最终是 allow），就增加警告计数
	// 或者 action 是 warn/block 也增加警告计数
	if (hasRisk || detectionAction === 'warn' || detectionAction === 'block') {
		// 触发风险，增加警告计数，重置放行计数
		updates.consecutiveWarningCount = state.consecutiveWarningCount + 1;
		updates.consecutiveAllowCount = 0;
		updates.lastDetectionAction = detectionAction;

		// 记录触发方向
		console.log(`[策略升级] ${direction}检测触发风险: action=${detectionAction}, hasRisk=${hasRisk}, 累计警告次数: ${updates.consecutiveWarningCount}`);

		// 检查是否达到升级阈值且未升级
		if (!state.isEscalated && updates.consecutiveWarningCount >= config.threshold) {
			// 获取目标策略
			let targetPolicyId = config.targetPolicyId;
			if (!targetPolicyId) {
				targetPolicyId = await getDefaultStrictPolicyId(scope);
			}

			if (targetPolicyId) {
				updates.currentPolicyId = targetPolicyId;
				updates.isEscalated = true;
				updates.escalatedAt = new Date();
				shouldEscalate = true;
				message = '您已升级为严格策略，请文明合规使用AI';
				console.log(`[策略升级] 达到升级阈值 ${config.threshold}，升级到策略: ${targetPolicyId}`);
			}
		}
	} else if (detectionAction === 'allow') {
		// 完全没有风险，增加放行计数
		updates.consecutiveAllowCount = state.consecutiveAllowCount + 1;
		updates.consecutiveWarningCount = 0;
		updates.lastDetectionAction = detectionAction;

		// 检查是否需要降级
		if (state.isEscalated) {
			// 检查是否在冷却期内
			if (!isInCooldown(state, config.cooldownMinutes)) {
				// 冷却期已过，检查放行次数是否达到降级阈值
				if (updates.consecutiveAllowCount >= config.deescalationThreshold) {
					updates.currentPolicyId = state.originalPolicyId;
					updates.isEscalated = false;
					updates.escalatedAt = null;
					updates.consecutiveAllowCount = 0;
					shouldDeescalate = true;
					message = '您已恢复宽容策略，请继续文明合规使用AI';
				}
			}
		}
	}

	// 5. 更新状态
	if (Object.keys(updates).length > 0) {
		await updateUserPolicyState(scope, { id: state.id, ...updates });
		state = { ...state, ...updates } as UserPolicyState;
	}

	return {
		state,
		shouldEscalate,
		shouldDeescalate,
		effectivePolicyId: state.currentPolicyId,
		message,
	};
}

/**
 * 重置会话策略状态（刷新页面时调用）
 */
export async function resetSessionPolicyState(
	scope: TenantScope,
	userId: string,
	sessionId: string
): Promise<{ success: boolean }> {
	try {
		await deleteUserPolicyState(scope, userId, sessionId);
		return { success: true };
	} catch (error) {
		console.error('[策略升级] 重置会话状态失败:', error);
		return { success: false };
	}
}

/**
 * 获取当前生效策略ID
 */
export async function getEffectivePolicyId(
	scope: TenantScope,
	userId: string,
	sessionId: string,
	defaultPolicyId: string
): Promise<string> {
	const state = await getUserPolicyState(scope, userId, sessionId);
	return state?.currentPolicyId ?? defaultPolicyId;
}
