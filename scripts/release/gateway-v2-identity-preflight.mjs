import { X509Certificate, createPrivateKey, createPublicKey, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { load } from 'js-yaml';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exportedKey = key => key.export({ type: 'spki', format: 'der' });
function pemChain(pem) {
  if (typeof pem !== 'string' || pem.length > 131072) throw new Error('CERTIFICATE_BUNDLE_INVALID');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu);
  if (!blocks?.length || blocks.length > 16 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu, '').trim()) throw new Error('CERTIFICATE_BUNDLE_INVALID');
  return blocks.map(block => new X509Certificate(block));
}
export function validateGatewayIdentityMaterial(input) {
  const now = input.now ?? Date.now(), minimumDays = input.minimumRemainingDays ?? 30;
  if (!Number.isSafeInteger(minimumDays) || minimumDays < 1 || minimumDays > 365 || !Number.isFinite(now)) throw new Error('CERTIFICATE_VALIDITY_POLICY_INVALID');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(input.release ?? '') || !Number.isSafeInteger(input.replicas) || input.replicas < 2 || input.replicas > 100) throw new Error('STATEFUL_IDENTITY_SCOPE_INVALID');
  const anchors = pemChain(input.caPem);
  const valid = certificate => Number.isFinite(Date.parse(certificate.validFrom)) && Date.parse(certificate.validFrom) <= now &&
    Date.parse(certificate.validTo) - now >= minimumDays * 86400000;
  if (anchors.some(certificate => !certificate.ca || !valid(certificate))) throw new Error('TRUST_ANCHOR_INVALID_OR_EXPIRING');
  const certificates = new Set(), privateKeys = new Set(), secrets = new Set(), checked = [];
  function certificatePair(material, names, usages, label) {
    const chain = pemChain(material.certificatePem), leaf = chain[0], fingerprint = sha(leaf.raw);
    if (leaf.ca || chain.some(certificate => !valid(certificate))) throw new Error('LEAF_CERTIFICATE_INVALID_OR_EXPIRING');
    const key = createPrivateKey(material.privateKeyPem), publicKey = createPublicKey(key), encoded = exportedKey(publicKey);
    if (!encoded.equals(exportedKey(leaf.publicKey))) throw new Error('CERTIFICATE_PRIVATE_KEY_MISMATCH');
    if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('WEAK_CERTIFICATE_KEY');
    if (!['rsa', 'ec', 'ed25519'].includes(key.asymmetricKeyType)) throw new Error('UNSUPPORTED_CERTIFICATE_KEY');
    for (const name of names) if (leaf.checkHost(name, { wildcards: false }) !== name) throw new Error('CERTIFICATE_SERVICE_NAME_MISMATCH');
    for (const usage of usages) if (!leaf.keyUsage?.includes(usage)) throw new Error('CERTIFICATE_EXTENDED_USAGE_REQUIRED');
    let current = leaf; const visited = new Set([fingerprint]); let trusted = false;
    for (let depth = 0; depth < 16; depth++) {
      if (anchors.some(anchor => current.checkIssued(anchor) && current.verify(anchor.publicKey))) { trusted = true; break; }
      const issuer = chain.slice(1).find(candidate => candidate.ca && !visited.has(sha(candidate.raw)) && current.checkIssued(candidate) && current.verify(candidate.publicKey));
      if (!issuer) break; visited.add(sha(issuer.raw)); current = issuer;
    }
    if (!trusted) throw new Error('CERTIFICATE_CHAIN_UNTRUSTED');
    if (certificates.has(fingerprint) || privateKeys.has(sha(encoded))) throw new Error('WORKLOAD_IDENTITY_REUSED');
    certificates.add(fingerprint); privateKeys.add(sha(encoded));
    checked.push({ role: label, certificateSha256: fingerprint, expiresAt: new Date(leaf.validTo).toISOString() });
    return fingerprint;
  }
  const workloads = input.workloads;
  if (!workloads || typeof workloads !== 'object' || Array.isArray(workloads)) throw new Error('WORKLOAD_REGISTRY_REQUIRED');
  for (const [nodeId, entry] of Object.entries(workloads)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(nodeId) || !entry || !['proxy', 'bff'].includes(entry.role) || typeof entry.secret !== 'string' || Buffer.byteLength(entry.secret) < 32 ||
      !/^[a-f0-9]{64}$/u.test(entry.certificateSha256 ?? '') || Object.keys(entry).some(key => !['secret', 'role', 'certificateSha256'].includes(key))) throw new Error('WORKLOAD_REGISTRY_INVALID');
    const digest = sha(entry.secret); if (secrets.has(digest)) throw new Error('WORKLOAD_SECRET_REUSED'); secrets.add(digest);
  }
  if (!Array.isArray(input.identities) || input.identities.length !== input.replicas || Object.values(workloads).filter(entry => entry.role === 'proxy').length !== input.replicas) throw new Error('PROXY_IDENTITY_COUNT_MISMATCH');
  const base = input.release + '-v2';
  for (let ordinal = 0; ordinal < input.replicas; ordinal++) {
    const nodeId = base + '-proxy-' + ordinal, material = input.identities.find(identity => identity.nodeId === nodeId), registry = workloads[nodeId];
    if (!material || registry?.role !== 'proxy') throw new Error('PROXY_ORDINAL_IDENTITY_MISSING');
    const fingerprint = certificatePair(material, [base + '-proxy', nodeId], ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'], nodeId);
    if (fingerprint !== registry.certificateSha256) throw new Error('PROXY_CERTIFICATE_PIN_MISMATCH');
    if (typeof material.secret !== 'string' || !timingSafeEqual(Buffer.from(sha(material.secret)), Buffer.from(sha(registry.secret)))) throw new Error('PROXY_WORKLOAD_SECRET_MISMATCH');
  }
  certificatePair(input.control, [base + '-control'], ['1.3.6.1.5.5.7.3.1'], 'control');
  certificatePair(input.console, [], ['1.3.6.1.5.5.7.3.2'], 'console');
  const signing = createPrivateKey(input.signingPrivateKeyPem);
  if (signing.asymmetricKeyType !== 'ed25519' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(input.keyId ?? '') || !input.publicKeys?.[input.keyId]) throw new Error('ACTIVE_SIGNING_KEY_REQUIRED');
  const active = exportedKey(createPublicKey(signing));
  if (!active.equals(exportedKey(createPublicKey(input.publicKeys[input.keyId])))) throw new Error('SIGNING_PUBLIC_KEY_MISMATCH');
  const authKeys = new Set();
  for (const pem of Object.values(input.publicKeys)) {
    const key = createPublicKey(pem); if (key.asymmetricKeyType !== 'ed25519') throw new Error('AUTH_PUBLIC_KEY_ALGORITHM_INVALID');
    const digest = sha(exportedKey(key)); if (authKeys.has(digest) || privateKeys.has(digest)) throw new Error('SIGNING_KEY_REUSED'); authKeys.add(digest);
  }
  return { version: '1.0', status: 'PASS', scope: 'local certificate, key and workload-registry consistency; no Kubernetes/network runtime certification',
    release: input.release, provisionedIdentities: input.replicas, minimumRemainingDays: minimumDays, checked,
    activeSigningKeyId: input.keyId, activeSigningPublicKeySha256: sha(active), trustAnchorFingerprints: anchors.map(anchor => sha(anchor.raw)) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { values: { type: 'string' }, release: { type: 'string' }, material: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.values || !values.release || !values.material || !values.output) throw new Error('Use --values <helm-values.yaml> --release <release> --material <private material directory> --output <new preflight.json>');
  const config = load(readFileSync(values.values, 'utf8')), directory = path.resolve(values.material);
  const read = file => readFileSync(path.join(directory, file), 'utf8');
  const replicas = config.provisionedProxyIdentities;
  if (!Number.isSafeInteger(replicas) || replicas < 2 || replicas > 100 || !Number.isSafeInteger(config.proxyReplicas) || config.proxyReplicas < 2 || config.proxyReplicas > replicas) throw new Error('INVALID_PROXY_PROVISIONING');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(values.release)) throw new Error('RELEASE_NAME_INVALID');
  const pair = name => ({ certificatePem: read(name + '.crt'), privateKeyPem: read(name + '.key') });
  const identities = Array.from({ length: replicas }, (_, ordinal) => { const nodeId = values.release + '-v2-proxy-' + ordinal; return { nodeId, ...pair(nodeId), secret: read(nodeId + '.secret').trim() }; });
  const result = validateGatewayIdentityMaterial({ release: values.release, replicas, identities, workloads: JSON.parse(read('workloads.json')),
    caPem: read('ca.crt'), control: pair('control'), console: pair('console'), signingPrivateKeyPem: read('signing.pem'), publicKeys: JSON.parse(read('public-keys.json')), keyId: config.keyId });
  writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ status: result.status, checked: result.checked.length, provisionedIdentities: replicas }));
}
