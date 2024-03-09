import { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import { CookieJar } from 'tough-cookie';
import qs from "qs";
import { CliUx } from '@oclif/core';

async function logCookiesAndCheckCsrf(cookieJar: CookieJar, baseUrl: string): Promise<string | null> {
  const cookies = await new Promise<string>((resolve, reject) => {
    /* eslint-disable-next-line */
    cookieJar.getCookies(baseUrl, (err: any, cookies: any[]) => {
      if (err) reject(err);
      else resolve(cookies.join('; '));
    });
  });

  const csrfTokenRegex: RegExp = /next-auth\.csrf-token=([^;]+)/;
  const match = csrfTokenRegex.exec(cookies);
  const csrfToken = match ? match[1] : null;
  return csrfToken;
}

export async function loginAndPublish(client: AxiosInstance, cookieJar: CookieJar, signer: ethers.Wallet, baseUrl: string, projectID: string, path: string, targetChannel: string) {
  await client.get(`${baseUrl}/api/auth/session`);

  const hasCsrfToken = await logCookiesAndCheckCsrf(cookieJar, baseUrl);
  if (!hasCsrfToken) {
    throw new Error("CSRF token not found in the cookie jar.");
  }

  const csrfResponse = await client.get(`${baseUrl}/api/auth/csrf`);
  const csrfToken = csrfResponse.data.csrfToken;

  CliUx.ux.action.start('Signing into HyperPlay API with:', signer.address);
  const siweMessage = new SiweMessage({
    domain: new URL(baseUrl).host,
    address: signer.address,
    statement: "Sign in with Ethereum to HyperPlay",
    uri: baseUrl,
    version: "1",
    chainId: 137,
    nonce: csrfToken,
    issuedAt: new Date().toISOString(),
  });

  const message = siweMessage.prepareMessage();
  const signature = await signer.signMessage(message);

  const formData = qs.stringify({
    message: JSON.stringify(siweMessage),
    redirect: 'false',
    signature: signature,
    csrfToken: csrfToken,
    callbackUrl: `${baseUrl}/`,
    json: 'true',
  });

  await client.post(`${baseUrl}/api/auth/callback/ethereum?`, formData, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
  });
  CliUx.ux.action.stop();

  CliUx.ux.log('Fetching listing release branches');
  const channels = (await client.get<{ channel_id: number, channel_name: string }[]>(`${baseUrl}/api/v1/channels?project_id=${projectID}`)).data;

  const releaseChannel = channels.find((channel) => targetChannel === channel.channel_name);

  CliUx.ux.log('Submitting release for review');
  await client.post(`${baseUrl}/api/v1/reviews/release`, {
    path,
    channel_id: releaseChannel?.channel_id,
  });
}
