import { createHash, timingSafeEqual } from 'node:crypto';
import { open, rm } from 'node:fs/promises';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const approvedRedirectHosts = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const maximumRedirects = 5;

export type DigestComparator = (left: Uint8Array, right: Uint8Array) => boolean;

export type DownloadRecoveryAssetOptions = Readonly<{
  url: string;
  destination: string;
  expectedSha256: string;
  maxBytes: number;
  fetch?: typeof globalThis.fetch;
}>;

export type DownloadRecoveryAssetResult = Readonly<{
  bytes: number;
  sha256: string;
}>;

export function isApprovedRedirectUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    approvedRedirectHosts.has(url.hostname)
  );
}

export function digestsEqual(
  expected: string,
  actual: string,
  compare: DigestComparator = timingSafeEqual,
): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(expected) || !/^[a-fA-F0-9]{64}$/.test(actual)) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && compare(expectedBytes, actualBytes);
}

async function fetchWithoutUnapprovedRedirects(
  initialUrl: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<Response> {
  let currentUrl = new URL(initialUrl);
  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    const response = await fetchImplementation(currentUrl, { redirect: 'manual' });
    if (!redirectStatuses.has(response.status)) {
      return response;
    }
    if (redirects === maximumRedirects) {
      throw new Error(`Recovery download exceeded ${maximumRedirects} redirects`);
    }
    const location = response.headers.get('location');
    if (location === null) {
      throw new Error(`Recovery download redirect ${response.status} omitted Location`);
    }
    const nextUrl = new URL(location, currentUrl);
    if (!isApprovedRedirectUrl(nextUrl)) {
      throw new Error(`Recovery download refused unapproved redirect host: ${nextUrl.hostname}`);
    }
    await response.body?.cancel();
    currentUrl = nextUrl;
  }
  throw new Error('Recovery download redirect limit is unreachable');
}

export async function downloadRecoveryAsset(
  options: DownloadRecoveryAssetOptions,
): Promise<DownloadRecoveryAssetResult> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const response = await fetchWithoutUnapprovedRedirects(options.url, fetchImplementation);
  if (!response.ok) {
    throw new Error(`Recovery asset request failed with HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error('Recovery asset response has no body');
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > options.maxBytes) {
      await response.body.cancel();
      throw new Error(`Recovery asset exceeds the manifest maximum asset size of ${options.maxBytes} bytes`);
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(options.destination, 'wx', 0o600);
    created = true;
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const chunk = Buffer.from(next.value);
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          await reader.cancel();
          throw new Error(`Recovery asset exceeds the manifest maximum asset size of ${options.maxBytes} bytes`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const sha256 = hash.digest('hex');
    if (!digestsEqual(options.expectedSha256, sha256)) {
      throw new Error(`Recovery asset digest mismatch: expected ${options.expectedSha256}, received ${sha256}`);
    }
    return Object.freeze({ bytes, sha256 });
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (created) {
      await rm(options.destination, { force: true });
    }
    throw error;
  }
}
