import { beforeEach, describe, expect, it, vi } from 'vitest';
const dns = vi.hoisted(() => ({resolve4:vi.fn<() => Promise<string[]>>(),resolve6:vi.fn<() => Promise<string[]>>(),lookup:vi.fn<() => Promise<Array<{address:string;family:number}>>>()}));
vi.mock('node:dns/promises', () => dns);
import { ProviderEndpointPolicy } from '../../src/lib/egress/endpoint-policy';
describe('system host resolution with unchanged egress boundary', () => {
 beforeEach(() => { dns.resolve4.mockRejectedValue(new Error('DNS unavailable')); dns.resolve6.mockRejectedValue(new Error('DNS unavailable')); dns.lookup.mockResolvedValue([{ address:'10.20.0.8', family:4 }]); });
 it('permits an explicitly approved OS-only private service', async () => {
  await expect(new ProviderEndpointPolicy({allowedPrivateHosts:['service.internal']}).assertAllowed('http://service.internal:9000','custom')).resolves.toBeInstanceOf(URL);
 });
 it('rejects OS private addresses without private host approval', async () => {
  await expect(new ProviderEndpointPolicy({allowedHosts:['service.internal']}).assertAllowed('https://service.internal','custom')).rejects.toMatchObject({code:'ADDRESS_RESTRICTED'});
 });
 it('does not let public DNS hide a private OS override', async () => {
  dns.resolve4.mockResolvedValue(['93.184.216.34']);
  await expect(new ProviderEndpointPolicy({allowedHosts:['service.internal']}).assertAllowed('https://service.internal','custom')).rejects.toMatchObject({code:'ADDRESS_RESTRICTED'});
 });
 it('fails closed when no resolver returns an address', async () => {
  dns.lookup.mockRejectedValue(new Error('OS unavailable'));
  await expect(new ProviderEndpointPolicy({allowedPrivateHosts:['service.internal']}).assertAllowed('http://service.internal','custom')).rejects.toMatchObject({code:'DNS_RESOLUTION_FAILED'});
 });
});
