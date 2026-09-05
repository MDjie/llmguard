import registry from '../../../data/content-safety/taxonomy/risk-registry.v1.json';
export const riskRegistryVersion = registry.version;
export const riskRegistry = registry.risks;
export function riskDefinition(riskId: string, custom: Readonly<Record<string,string>> = {}): string {
  const definition = custom[riskId] ?? riskRegistry.find(r => r.id === riskId)?.definition;
  if (!definition?.trim()) throw new Error('RISK_DEFINITION_UNKNOWN:' + riskId);
  return definition;
}
export function contextualRisk(riskId: string): boolean {
  return riskRegistry.some(r => r.id === riskId && r.contextPolicy === 'contextual_review');
}
