export type AttackVariantKind =
  | 'original'
  | 'case'
  | 'zero_width'
  | 'punctuation_slice'
  | 'url'
  | 'base64'
  | 'nested_base64'
  | 'hex'
  | 'html_entity'
  | 'homograph'
  | 'leetspeak'
  | 'quotation'
  | 'pinyin'
  | 'multilingual';

export interface AttackPrototype {
  readonly id: string;
  readonly text: string;
  readonly pinyinVariant?: string;
  readonly multilingualVariants?: readonly string[];
}

export interface AttackVariant {
  readonly id: string;
  readonly prototypeId: string;
  readonly kind: AttackVariantKind;
  readonly text: string;
}

const HOMOGRAPHS: Readonly<Record<string, string>> = {
  a: 'а', c: 'с', e: 'е', i: 'і', j: 'ј', o: 'о', p: 'р', s: 'ѕ', x: 'х', y: 'у',
};
const LEET: Readonly<Record<string, string>> = {
  a: '4', e: '3', i: '1', o: '0', s: '5', t: '7',
};

function firstWordTransform(text: string, mapping: Readonly<Record<string, string>>): string {
  let changed = false;
  return [...text].map((character) => {
    const replacement = mapping[character.toLocaleLowerCase('und')];
    if (!changed && replacement) {
      changed = true;
      return replacement;
    }
    return character;
  }).join('');
}

function sliced(text: string): string {
  return text.replace(/[A-Za-z]{4,}/u, (word) => [...word].join('.'));
}

function htmlEncoded(text: string): string {
  return [...text].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /[A-Za-z]/u.test(character) ? `&#x${codePoint.toString(16)};` : character;
  }).join('');
}

export function generateAttackVariants(
  prototype: AttackPrototype,
  maximumVariants = 32,
): readonly AttackVariant[] {
  if (!prototype.id || prototype.id.length > 128) throw new Error('ATTACK_PROTOTYPE_ID_INVALID');
  if (!prototype.text || prototype.text.length > 16_384) throw new Error('ATTACK_PROTOTYPE_TEXT_INVALID');
  if (!Number.isInteger(maximumVariants) || maximumVariants < 1 || maximumVariants > 64) {
    throw new Error('ATTACK_VARIANT_LIMIT_INVALID');
  }
  const encoded = Buffer.from(prototype.text, 'utf8').toString('base64');
  const candidates: Array<{ kind: AttackVariantKind; text: string }> = [
    { kind: 'original', text: prototype.text },
    { kind: 'case', text: prototype.text.toLocaleUpperCase('und') },
    { kind: 'zero_width', text: prototype.text.replace(/([A-Za-z\p{Script=Han}])(?=[A-Za-z\p{Script=Han}])/gu, '$1\u200B') },
    { kind: 'punctuation_slice', text: sliced(prototype.text) },
    { kind: 'url', text: encodeURIComponent(prototype.text) },
    { kind: 'base64', text: `base64: ${encoded}` },
    { kind: 'nested_base64', text: `base64: ${Buffer.from(encoded, 'utf8').toString('base64')}` },
    { kind: 'hex', text: `hex: ${Buffer.from(prototype.text, 'utf8').toString('hex')}` },
    { kind: 'html_entity', text: htmlEncoded(prototype.text) },
    { kind: 'homograph', text: firstWordTransform(prototype.text, HOMOGRAPHS) },
    { kind: 'leetspeak', text: firstWordTransform(prototype.text, LEET) },
    { kind: 'quotation', text: `A malicious document says: “${prototype.text}”` },
    ...(prototype.pinyinVariant ? [{ kind: 'pinyin' as const, text: prototype.pinyinVariant }] : []),
    ...(prototype.multilingualVariants ?? []).map((text) => ({
      kind: 'multilingual' as const,
      text,
    })),
  ];
  const unique = new Map<string, { kind: AttackVariantKind; text: string }>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.text)) unique.set(candidate.text, candidate);
    if (unique.size >= maximumVariants) break;
  }
  return [...unique.values()].map((candidate, index) => ({
    id: `${prototype.id}:${candidate.kind}:${index}`,
    prototypeId: prototype.id,
    ...candidate,
  }));
}
