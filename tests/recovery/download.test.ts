import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  digestsEqual,
  downloadRecoveryAsset,
  isApprovedRedirectUrl,
} from '../../src/recovery/download.js';
import { hashBytes } from '../../src/project/hash.js';

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'course-recovery-download-'));
  temporaryDirectories.push(directory);
  return join(directory, 'asset.tar.gz');
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server');
  return `http://127.0.0.1:${address.port}`;
}

describe('recovery download', () => {
  it('streams the response to disk while calculating SHA-256', async () => {
    const chunks = [Buffer.from('streamed-'), Buffer.from('archive')];
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200);
      response.write(chunks[0]);
      response.end(chunks[1]);
    });
    const destination = await temporaryFile();
    const expectedSha256 = hashBytes(Buffer.concat(chunks));

    const result = await downloadRecoveryAsset({
      url: `${baseUrl}/asset.tar.gz`,
      destination,
      expectedSha256,
      maxBytes: 1024,
    });

    expect(result).toEqual({ bytes: 16, sha256: expectedSha256 });
    expect(await readFile(destination)).toEqual(Buffer.concat(chunks));
  });

  it.each([
    'https://github.com/owner/repository/releases/download/tag/asset.tar.gz',
    'https://objects.githubusercontent.com/github-production-release-asset/file',
    'https://release-assets.githubusercontent.com/github-production-release-asset/file',
  ])('allows the fixed GitHub redirect host %s', (url) => {
    expect(isApprovedRedirectUrl(new URL(url))).toBe(true);
  });

  it.each([
    'http://github.com/owner/repository',
    'https://github.com.evil.example/asset',
    'https://raw.githubusercontent.com/owner/repository/file',
    'https://example.com/asset',
  ])('does not broaden the redirect policy for %s', (url) => {
    expect(isApprovedRedirectUrl(new URL(url))).toBe(false);
  });

  it('follows an approved redirect host through the fixed policy', async () => {
    const bytes = Buffer.from('approved redirect bytes');
    const baseUrl = await serve((request, response) => {
      if (request.url === '/initial') {
        response.writeHead(302, {
          location: 'https://release-assets.githubusercontent.com/github-production-release-asset/immutable',
        });
        response.end();
        return;
      }
      expect(request.url).toBe('/approved');
      response.end(bytes);
    });
    const requestedUrls: string[] = [];
    const routedFetch: typeof fetch = async (input, init) => {
      const requested = new URL(input instanceof Request ? input.url : String(input));
      requestedUrls.push(requested.href);
      const routed = requested.hostname === 'release-assets.githubusercontent.com'
        ? `${baseUrl}/approved`
        : requested;
      return fetch(routed, init);
    };
    const destination = await temporaryFile();

    await downloadRecoveryAsset({
      url: `${baseUrl}/initial`,
      destination,
      expectedSha256: hashBytes(bytes),
      maxBytes: 1024,
      fetch: routedFetch,
    });

    expect(requestedUrls[1]).toBe(
      'https://release-assets.githubusercontent.com/github-production-release-asset/immutable',
    );
    expect(await readFile(destination)).toEqual(bytes);
  });

  it('rejects a redirect to an unapproved host without requesting it', async () => {
    let redirectedRequests = 0;
    const unapproved = await serve((_request, response) => {
      redirectedRequests += 1;
      response.end('must not be requested');
    });
    const initial = await serve((_request, response) => {
      response.writeHead(302, { location: `${unapproved}/stolen` });
      response.end();
    });
    const destination = await temporaryFile();

    await expect(downloadRecoveryAsset({
      url: `${initial}/asset.tar.gz`,
      destination,
      expectedSha256: '0'.repeat(64),
      maxBytes: 1024,
    })).rejects.toThrow(/unapproved redirect host/i);
    expect(redirectedRequests).toBe(0);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([404, 500])('rejects a non-success response %s and leaves no file', async (status) => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(status);
      response.end('failure');
    });
    const destination = await temporaryFile();

    await expect(downloadRecoveryAsset({
      url: `${baseUrl}/missing.tar.gz`,
      destination,
      expectedSha256: '0'.repeat(64),
      maxBytes: 1024,
    })).rejects.toThrow(new RegExp(String(status)));
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops and removes the download when the declared maximum is exceeded', async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200);
      response.write('1234');
      response.end('5678');
    });
    const destination = await temporaryFile();

    await expect(downloadRecoveryAsset({
      url: `${baseUrl}/large.tar.gz`,
      destination,
      expectedSha256: '0'.repeat(64),
      maxBytes: 4,
    })).rejects.toThrow(/maximum asset size/i);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the supplied timing-safe comparator only for equal-length digests', () => {
    const compare = vi.fn(() => true);
    const left = 'a'.repeat(64);
    const right = 'b'.repeat(64);

    expect(digestsEqual(left, right, compare)).toBe(true);
    expect(compare).toHaveBeenCalledOnce();
    expect(digestsEqual(left, 'b'.repeat(62), compare)).toBe(false);
    expect(digestsEqual('not-hex', right, compare)).toBe(false);
    expect(compare).toHaveBeenCalledOnce();
  });

  it('rejects a digest mismatch and removes the downloaded file', async () => {
    const baseUrl = await serve((_request, response) => response.end('wrong bytes'));
    const destination = await temporaryFile();

    await expect(downloadRecoveryAsset({
      url: `${baseUrl}/asset.tar.gz`,
      destination,
      expectedSha256: '0'.repeat(64),
      maxBytes: 1024,
    })).rejects.toThrow(/digest mismatch/i);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
