/**
 * PII 自动脱敏引擎
 * 支持手机号、身份证号、银行卡号、邮箱、IP地址、API Key等敏感信息的自动脱敏
 */

export interface MaskResult {
  /** 脱敏后的文本 */
  maskedText: string
  /** 脱敏的PII项列表 */
  maskedItems: MaskedItem[]
  /** 是否进行了脱敏 */
  hasMasked: boolean
}

export interface MaskedItem {
  /** PII类型 */
  type: 'phone' | 'idcard' | 'bankcard' | 'email' | 'ip' | 'apikey' | 'address'
  /** 脱敏后的值 */
  masked: string
  /** 在原文中的位置 */
  position: {
    start: number
    end: number
  }
}

/**
 * 手机号脱敏：13812345678 → 138****5678
 */
function maskPhone(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  // 匹配中国大陆手机号
  const phoneRegex = /(?<!\d)(1[3-9]\d{9})(?!\d)/g
  
  let result = text
  let match: RegExpExecArray | null
  
  // 先收集所有匹配项
  const matches: { original: string; index: number }[] = []
  while ((match = phoneRegex.exec(text)) !== null) {
    matches.push({ original: match[0], index: match.index })
  }
  
  // 从后往前替换，避免位置偏移
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const original = m.original
    const masked = original.substring(0, 3) + '****' + original.substring(7)
    result = result.substring(0, m.index) + masked + result.substring(m.index + original.length)
    
    items.unshift({
      type: 'phone',
      masked,
      position: { start: m.index, end: m.index + original.length }
    })
  }
  
  return { text: result, items }
}

/**
 * 身份证号脱敏：110101199001011234 → 110101********1234
 */
function maskIdCard(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  // 匹配18位身份证号
  const idCardRegex = /(?<!\d)(\d{6})(\d{8})(\d{4})(?!\d)/g
  
  let result = text
  let match: RegExpExecArray | null
  
  const matches: { original: string; index: number }[] = []
  while ((match = idCardRegex.exec(text)) !== null) {
    matches.push({ original: match[0], index: match.index })
  }
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const original = m.original
    const masked = original.substring(0, 6) + '********' + original.substring(14)
    result = result.substring(0, m.index) + masked + result.substring(m.index + original.length)
    
    items.unshift({
      type: 'idcard',
      masked,
      position: { start: m.index, end: m.index + original.length }
    })
  }
  
  return { text: result, items }
}

/**
 * 银行卡号脱敏：6222021234567890123 → 6222************123
 */
function maskBankCard(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  // 匹配16-19位银行卡号
  const bankCardRegex = /(?<!\d)(\d{4})(\d{8,12})(\d{3})(?!\d)/g
  
  let result = text
  let match: RegExpExecArray | null
  
  const matches: { original: string; index: number }[] = []
  while ((match = bankCardRegex.exec(text)) !== null) {
    matches.push({ original: match[0], index: match.index })
  }
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const original = m.original
    const masked = original.substring(0, 4) + '************' + original.substring(original.length - 3)
    result = result.substring(0, m.index) + masked + result.substring(m.index + original.length)
    
    items.unshift({
      type: 'bankcard',
      masked,
      position: { start: m.index, end: m.index + original.length }
    })
  }
  
  return { text: result, items }
}

/**
 * 邮箱脱敏：user@example.com → u***@example.com
 */
function maskEmail(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  const emailRegex = /([a-zA-Z0-9])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
  
  let result = text
  let match: RegExpExecArray | null
  
  const matches: { original: string; index: number; firstChar: string; domain: string }[] = []
  while ((match = emailRegex.exec(text)) !== null) {
    matches.push({
      original: match[0],
      index: match.index,
      firstChar: match[1],
      domain: match[2]
    })
  }
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const masked = m.firstChar + '***@' + m.domain
    result = result.substring(0, m.index) + masked + result.substring(m.index + m.original.length)
    
    items.unshift({
      type: 'email',
      masked,
      position: { start: m.index, end: m.index + m.original.length }
    })
  }
  
  return { text: result, items }
}

/**
 * IP地址脱敏：192.168.1.1 → 192.168.*.*
 */
function maskIP(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  // 匹配IPv4地址
  const ipRegex = /(?<!\d)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d)/g
  
  let result = text
  let match: RegExpExecArray | null
  
  const matches: { original: string; index: number }[] = []
  while ((match = ipRegex.exec(text)) !== null) {
    matches.push({ original: match[0], index: match.index })
  }
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const original = m.original
    const parts = original.split('.')
    const masked = parts[0] + '.' + parts[1] + '.*.*'
    result = result.substring(0, m.index) + masked + result.substring(m.index + original.length)
    
    items.unshift({
      type: 'ip',
      masked,
      position: { start: m.index, end: m.index + original.length }
    })
  }
  
  return { text: result, items }
}

/**
 * API Key脱敏：sk-xxxxxxxxxxxxxxxx → sk-****
 */
function maskApiKey(text: string): { text: string; items: MaskedItem[] } {
  const items: MaskedItem[] = []
  // 匹配常见API Key格式
  const apiKeyPatterns = [
    /(?:sk-|AKIA|Bearer\s+|api_key[=:]\s*|token[=:]\s*|secret[=:]\s*)([a-zA-Z0-9_-]{16,})/gi,
    /(?:access_key|private_key|api_secret)[=:]\s*['"]?([a-zA-Z0-9_-]{16,})['"]?/gi
  ]
  
  let result = text
  
  for (const pattern of apiKeyPatterns) {
    let match: RegExpExecArray | null
    const matches: { original: string; index: number }[] = []
    
    pattern.lastIndex = 0 // 重置正则
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ original: match[0], index: match.index })
    }
    
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]
      const original = m.original
      // 保留前缀，脱敏值部分
      const prefix = original.match(/^(?:sk-|AKIA|Bearer\s+|api_key[=:]\s*|token[=:]\s*|secret[=:]\s*)/i)?.[0] || ''
      const masked = prefix + '****'
      result = result.substring(0, m.index) + masked + result.substring(m.index + original.length)
      
      items.unshift({
        type: 'apikey',
          masked,
        position: { start: m.index, end: m.index + original.length }
      })
    }
  }
  
  return { text: result, items }
}

/**
 * 主脱敏函数
 * 按顺序对文本中的各种PII进行脱敏
 */
export function maskPII(text: string): MaskResult {
  let maskedText = text
  const allItems: MaskedItem[] = []
  
  // 按顺序进行各类脱敏
  // 1. API Key（优先级最高，避免被其他规则破坏）
  const apiKeyResult = maskApiKey(maskedText)
  maskedText = apiKeyResult.text
  allItems.push(...apiKeyResult.items)
  
  // 2. 身份证号
  const idCardResult = maskIdCard(maskedText)
  maskedText = idCardResult.text
  allItems.push(...idCardResult.items)
  
  // 3. 银行卡号
  const bankCardResult = maskBankCard(maskedText)
  maskedText = bankCardResult.text
  allItems.push(...bankCardResult.items)
  
  // 4. 手机号
  const phoneResult = maskPhone(maskedText)
  maskedText = phoneResult.text
  allItems.push(...phoneResult.items)
  
  // 5. 邮箱
  const emailResult = maskEmail(maskedText)
  maskedText = emailResult.text
  allItems.push(...emailResult.items)
  
  // 6. IP地址
  const ipResult = maskIP(maskedText)
  maskedText = ipResult.text
  allItems.push(...ipResult.items)
  
  // 按位置排序
  allItems.sort((a, b) => a.position.start - b.position.start)
  
  return {
    maskedText,
    maskedItems: allItems,
    hasMasked: allItems.length > 0
  }
}

/**
 * 对文本中的特定部分进行脱敏
 * @param text 原始文本
 * @param start 起始位置
 * @param end 结束位置
 * @param maskChar 脱敏字符，默认为*
 */
export function maskRange(text: string, start: number, end: number, maskChar = '*'): string {
  if (start < 0 || end > text.length || start >= end) {
    return text
  }
  
  const maskedPart = maskChar.repeat(end - start)
  return text.substring(0, start) + maskedPart + text.substring(end)
}

/**
 * 检查文本是否包含PII
 */
export function hasPII(text: string): boolean {
  const result = maskPII(text)
  return result.hasMasked
}

/**
 * 获取文本中的PII统计
 */
export function getPIIStats(text: string): Record<string, number> {
  const result = maskPII(text)
  const stats: Record<string, number> = {}
  
  for (const item of result.maskedItems) {
    stats[item.type] = (stats[item.type] || 0) + 1
  }
  
  return stats
}
