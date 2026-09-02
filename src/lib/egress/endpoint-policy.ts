import { resolve4, resolve6 } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type ProviderType =
  | 'openai_compatible'
  | 'deepseek'
  | 'kimi'
  | 'doubao'
  | 'qwen'
  | 'glm'
  | 'ollama'
  | 'custom';

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

const PROVIDER_HOSTS: Readonly<Partial<Record<ProviderType, readonly string[]>>> = {
  openai_compatible: ['api.openai.com'],
  deepseek: ['api.deepseek.com'],
  kimi: ['api.moonshot.cn'],
  doubao: ['ark.cn-beijing.volces.com'],
  qwen: ['dashscope.aliyuncs.com'],
  glm: ['open.bigmodel.cn'],
};

export class EgressPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EgressPolicyError';
  }
}

function configuredHosts(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

async function systemResolver(hostname: string): Promise<readonly string[]> {
  if (ipaddr.isValid(hostname)) return [hostname];
  const [ipv4, ipv6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ];
  if (addresses.length === 0) throw new EgressPolicyError('DNS_RESOLUTION_FAILED', 'Provider host did not resolve');
  return addresses;
}

function isRestrictedAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return true;
  let address = ipaddr.parse(value);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  return address.range() !== 'unicast';
}

export interface ProviderEndpointPolicyOptions {
  readonly allowedHosts?: readonly string[];
  readonly allowedPrivateHosts?: readonly string[];
  readonly resolver?: DnsResolver;
}

export class ProviderEndpointPolicy {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedPrivateHosts: ReadonlySet<string>;
  private readonly resolver: DnsResolver;

  constructor(options: ProviderEndpointPolicyOptions = {}) {
    this.allowedHosts = new Set(
      (options.allowedHosts ?? configuredHosts(process.env.PROVIDER_ALLOWED_HOSTS)).map((host) =>
        host.toLowerCase(),
      ),
    );
    this.allowedPrivateHosts = new Set(
      (options.allowedPrivateHosts ?? configuredHosts(process.env.PROVIDER_ALLOWED_PRIVATE_HOSTS)).map(
        (host) => host.toLowerCase(),
      ),
    );
    this.resolver = options.resolver ?? systemResolver;
  }

  async assertAllowed(rawUrl: string | URL, providerType: ProviderType): Promise<URL> {
    let url: URL;
    try {
      url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    } catch {
      throw new EgressPolicyError('URL_INVALID', 'Provider endpoint URL is invalid');
    }

    if (url.username || url.password || url.hash) {
      throw new EgressPolicyError('URL_COMPONENT_REJECTED', 'Provider URL credentials and fragments are forbidden');
    }
    const hostname = url.hostname.toLowerCase();
    const privateAllowed = this.allowedPrivateHosts.has(hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateAllowed)) {
      throw new EgressPolicyError('SCHEME_REJECTED', 'Provider endpoint must use HTTPS');
    }

    const typeHosts = PROVIDER_HOSTS[providerType] ?? [];
    const hostAllowed = typeHosts.includes(hostname) || this.allowedHosts.has(hostname) || privateAllowed;
    if (!hostAllowed) {
      throw new EgressPolicyError('HOST_NOT_ALLOWED', 'Provider host is not on the outbound allowlist');
    }

    const addresses = await this.resolver(hostname);
    if (addresses.length === 0) {
      throw new EgressPolicyError('DNS_RESOLUTION_FAILED', 'Provider host did not resolve');
    }
    if (!privateAllowed && addresses.some(isRestrictedAddress)) {
      throw new EgressPolicyError('ADDRESS_RESTRICTED', 'Provider host resolves to a restricted address');
    }
    return url;
  }
}
