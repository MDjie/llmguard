import { NextRequest, NextResponse } from 'next/server';
import { detectWithDynamicRules, getDefaultPolicyId } from '@/lib/detection/dynamic-engine';
import { initDefaultPolicy } from '@/lib/detection/init-database';
import { getEffectivePolicyId } from '@/lib/policy/escalation-service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, policyId, direction = 'input', userId, sessionId } = body;

    if (!text) {
      return NextResponse.json(
        { success: false, error: '缺少必要参数: text' },
        { status: 400 }
      );
    }

    // 获取策略ID
    let targetPolicyId = policyId;
    if (!targetPolicyId) {
      targetPolicyId = await getDefaultPolicyId();
    }

    // 如果没有策略，尝试初始化默认策略
    if (!targetPolicyId) {
      console.log('未找到默认策略，尝试初始化...');
      await initDefaultPolicy();
      targetPolicyId = await getDefaultPolicyId();
    }

    if (!targetPolicyId) {
      return NextResponse.json(
        {
          success: false,
          error: '未找到策略配置。请先访问 /api/init-database 初始化数据库，或在检测维度管理页面配置检测规则。'
        },
        { status: 404 }
      );
    }

    // 策略升级逻辑：如果提供了sessionId，检查是否有升级后的策略
    let effectivePolicyId = targetPolicyId;
    const effectiveUserId = userId || 'anonymous';

    if (sessionId) {
      // 获取当前生效策略（输入和输出都使用升级后的策略）
      effectivePolicyId = await getEffectivePolicyId(effectiveUserId, sessionId, targetPolicyId);
      console.log(`[检测API] sessionId=${sessionId}, 原策略=${targetPolicyId}, 生效策略=${effectivePolicyId}`);
    }

    // 执行检测（不再在这里处理策略升级，由前端汇总调用 /api/escalation-summary）
    const result = await detectWithDynamicRules(text, effectivePolicyId, direction);

    // 构建响应数据
    const responseData: Record<string, unknown> = {
      text,
      direction,
      overallScore: result.overallScore,
      confidence: 0.85,
      action: result.action,
      findings: result.findings.map(f => ({
        dimension: f.dimension,
        dimensionName: f.dimensionName,
        score: f.score,
        confidence: 0.85,
        severity: f.score >= 80 ? 'high' : f.score >= 50 ? 'medium' : 'low',
        matchedRules: f.matchedRules,
        evidence: f.evidence,
        reason: f.reason,
        action: f.action,
      })),
      summary: result.summary,
      latencyMs: result.latencyMs,
      originalText: text,
      processedText: text,
      // 裁判模型结果
      judgeModel: result.judgeModelResult || null,
      decisionTrace: result.decisionTrace || null,
      // 策略信息（供前端判断是否有风险）
      effectivePolicyId,
      originalPolicyId: targetPolicyId,
    };

    // 添加脱敏处理 - 根据检测到的风险内容进行精确脱敏
    // 当 processingAction 是 mask 时执行脱敏
    if (result.processingAction === 'mask') {
      let maskedText = text;
      const maskDetails: { original: string; masked: string; type: string }[] = [];
      
      // 基于检测结果中的证据内容进行脱敏
      for (const finding of result.findings) {
        if (finding.evidence && finding.evidence.length > 0) {
          for (const evidence of finding.evidence) {
            if (evidence && evidence.length > 2) {
              // 保留首尾字符，中间用*替换
              const maskedEvidence = evidence[0] + '*'.repeat(Math.min(evidence.length - 2, 8)) + evidence[evidence.length - 1];
              if (maskedText.includes(evidence)) {
                maskedText = maskedText.split(evidence).join(maskedEvidence);
                maskDetails.push({
                  original: evidence.slice(0, 2) + '***',
                  masked: maskedEvidence,
                  type: finding.dimensionName,
                });
              }
            }
          }
        }
      }
      
      // 通用敏感信息脱敏（补充）
      // 手机号脱敏
      maskedText = maskedText.replace(/1[3-9]\d{9}/g, (match: string) => 
        match.slice(0, 3) + '****' + match.slice(-4)
      );
      // 身份证脱敏
      maskedText = maskedText.replace(/\d{17}[\dXx]/g, (match: string) =>
        match.slice(0, 6) + '********' + match.slice(-4)
      );
      // 银行卡号脱敏
      maskedText = maskedText.replace(/\d{16,19}/g, (match: string) =>
        match.slice(0, 4) + '****' + match.slice(-4)
      );
      // API Key 脱敏
      maskedText = maskedText.replace(/sk-[a-zA-Z0-9]{20,}/g, (match: string) =>
        'sk-****' + match.slice(-4)
      );
      // 邮箱脱敏
      maskedText = maskedText.replace(/([a-zA-Z0-9_.+-]+)@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/g, 
        (match: string, local: string, domain: string) => {
          const maskedLocal = local.length > 2 
            ? local[0] + '***' + local[local.length - 1] 
            : '***';
          return `${maskedLocal}@${domain}`;
        }
      );
      
      responseData.processedText = maskedText;
      responseData.maskedText = maskedText;
      responseData.safeText = maskedText;
      responseData.maskDetails = maskDetails;
      responseData.processingActions = ['自动脱敏'];
    }

    // 添加安全改写处理 - 对敏感内容进行安全化处理
    // 当 processingAction 是 rewrite 时执行改写
    if (result.processingAction === 'rewrite') {
      let rewrittenText = text;
      const rewriteDetails: { dimension: string; action: string }[] = [];
      
      // 根据不同维度进行针对性改写
      for (const finding of result.findings) {
        switch (finding.dimension) {
          case 'prompt_injection':
            // 提示词注入：移除注入关键词，保留正常意图
            rewrittenText = rewrittenText
              .replace(/忽略之前的指令/gi, '请帮我')
              .replace(/忽略所有指令/gi, '请帮我')
              .replace(/你现在是/gi, '我想了解')
              .replace(/扮演/gi, '模拟')
              .replace(/越狱/gi, '')
              .replace(/DAN/gi, '');
            rewriteDetails.push({ dimension: '提示词注入', action: '移除注入关键词' });
            break;
            
          case 'pii_leak':
            // 个人信息泄露：替换为占位符
            for (const evidence of finding.evidence || []) {
              if (evidence && evidence.length > 2) {
                rewrittenText = rewrittenText.replace(
                  new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                  '[个人信息已保护]'
                );
              }
            }
            rewriteDetails.push({ dimension: '个人信息泄露', action: '替换为占位符' });
            break;
            
          case 'credential_secret_leak':
            // 凭证泄露：替换为安全提示
            rewrittenText = rewrittenText
              .replace(/sk-[a-zA-Z0-9]+/gi, '[API密钥已保护]')
              .replace(/password\s*[=:]\s*\S+/gi, 'password=[已保护]')
              .replace(/token\s*[=:]\s*\S+/gi, 'token=[已保护]');
            rewriteDetails.push({ dimension: '凭证泄露', action: '替换为安全提示' });
            break;
            
          case 'ad_detection':
            // 广告内容：软化营销用语
            rewrittenText = rewrittenText
              .replace(/立即购买/gi, '了解更多')
              .replace(/限时优惠/gi, '当前信息')
              .replace(/点击链接/gi, '查看详情')
              .replace(/免费领取/gi, '获取信息');
            rewriteDetails.push({ dimension: '广告内容', action: '软化营销用语' });
            break;
            
          case 'spam_detection':
            // 垃圾内容：清理重复和无关内容
            rewrittenText = rewrittenText
              .replace(/(.)\1{3,}/g, '$1$1')  // 移除重复字符
              .replace(/\s+/g, ' ')  // 压缩空格
              .trim();
            rewriteDetails.push({ dimension: '垃圾内容', action: '清理无关内容' });
            break;
            
          default:
            // 默认：移除敏感证据内容
            for (const evidence of finding.evidence || []) {
              if (evidence && evidence.length > 2) {
                rewrittenText = rewrittenText.replace(
                  new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                  '[已安全化处理]'
                );
              }
            }
            rewriteDetails.push({ dimension: finding.dimensionName, action: '安全化处理' });
        }
      }
      
      // 如果改写后仍有风险标记，添加安全提示
      if (rewriteDetails.length > 0) {
        rewrittenText = rewrittenText.trim() + '\n\n[内容已进行安全化处理]';
      }
      
      responseData.processedText = rewrittenText;
      responseData.rewrittenText = rewrittenText;
      responseData.rewriteDetails = rewriteDetails;
      responseData.processingActions = ['安全改写'];
    }

    return NextResponse.json({ success: true, data: responseData });
  } catch (error) {
    console.error('检测失败:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: '检测服务异常，请检查数据库连接或联系管理员' 
      },
      { status: 500 }
    );
  }
}
