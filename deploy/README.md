# GuardLLM production deployment

The Helm chart deploys the gateway, control application and asynchronous workers into seven
isolated namespaces. Production installation is rejected unless every application image is
referenced by an immutable sha256 digest and runtime secrets already exist in each workload
namespace.

## Connected installation

1. Copy deploy/helm/guardllm/values.yaml to an environment-owned values file.
2. Replace all placeholder repositories and digests. Create guardllm-runtime-secrets through
   the organization's secret controller; never commit secret values.
3. Run node scripts/release/validate-production-values.mjs with the values file.
4. Apply the top-level deploy Kustomization, render the signature policy template with the trusted Cosign
   public key, then install with helm upgrade --install --atomic.
5. Enable serviceMonitor only after creating the metrics bearer token secret.

The default chart expects an Istio-compatible service mesh and enforces STRICT mTLS plus workload
identity policies. If the target has no mesh, disable serviceMesh, enable gatewayDirectTls and
mount the enterprise CA/client certificate. A TLS reverse proxy is then required in front of the
Node application. Plaintext cross-node traffic is not a supported production mode.

## Offline installation

On a connected, controlled build host, run scripts/release/build-offline-bundle.sh. It verifies
Cosign signatures, exports all images by digest, generates per-image CycloneDX SBOMs and creates
SHA256SUMS. Transfer the resulting directory through the approved media process and run
scripts/release/install-offline-bundle.sh on the target. The installer verifies every checksum
before loading images.

The chart does not install PostgreSQL, Redis, Kafka, object storage, search, PKI, GPU drivers or
observability operators. Those are platform services with independent lifecycle and HA controls;
their required topology and recovery procedures are in docs/runbooks.
