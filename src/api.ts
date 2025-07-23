import { AxiosInstance, AxiosError } from 'axios';
import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import { Cookie, CookieJar } from 'tough-cookie';
import qs from "qs";
import { CliUx } from '@oclif/core';

export async function logCookiesAndCheckCsrf(
  cookieJar: CookieJar,
  baseUrl: string
): Promise<string | null> {
  const cookiesArray: Cookie[] = await cookieJar.getCookies(baseUrl);
  const cookiesString = cookiesArray.map((cookie) => cookie.toString()).join('; ');

  const csrfTokenRegex: RegExp = /next-auth\.csrf-token=([^;]+)/;
  const match = csrfTokenRegex.exec(cookiesString);
  const csrfToken = match ? match[1] : null;
  return csrfToken;
}

async function getAuthSession(client: AxiosInstance): Promise<void> {
  try {
    await client.get("/api/auth/session");
  } catch (error) {
    console.log(`❌ Session request failed:`, error);
    throw error;
  }
}

async function getCsrfToken(client: AxiosInstance): Promise<string> {
  try {
    const csrfResponse = await client.get("/api/auth/csrf");
    return csrfResponse.data.csrfToken;
  } catch (error) {
    console.log(`❌ CSRF request failed:`, error);
    throw error;
  }
}

async function submitAuthCallback(client: AxiosInstance, formData: string): Promise<void> {
  try {
    await client.post("/api/auth/callback/ethereum?", formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
    });
  } catch (error) {
    console.log(`❌ Callback request failed:`, error);
    throw error;
  }
}

export async function login(client: AxiosInstance, cookieJar: CookieJar, signer: ethers.Wallet) {
  await getAuthSession(client);

  const hasCsrfToken = await logCookiesAndCheckCsrf(cookieJar, client.defaults.baseURL as string);
  if (!hasCsrfToken) {
    throw new Error("CSRF token not found in the cookie jar.");
  }

  const csrfToken = await getCsrfToken(client);
  const siweMessage = new SiweMessage({
    domain: new URL(client.defaults.baseURL as string).host,
    address: signer.address,
    statement: "Sign in with Ethereum to HyperPlay",
    uri: client.defaults.baseURL as string,
    version: "1",
    chainId: 1,
    nonce: csrfToken,
  });

  const message = siweMessage.prepareMessage();
  const signature = await signer.signMessage(message);

  const formData = qs.stringify({
    message: message,
    redirect: 'false',
    signature: signature,
    csrfToken: csrfToken,
    callbackUrl: "/",
    json: 'true',
  });

  await submitAuthCallback(client, formData);

  CliUx.ux.action.stop();
}

interface ApiErrorResponse {
  message?: string;
}

function extractApiError(axiosError: AxiosError): { status: number; statusText: string; apiError: string } {
  const status = axiosError.response?.status || 0;
  const statusText = axiosError.response?.statusText || '';
  const responseData = axiosError.response?.data as unknown as ApiErrorResponse;
  const apiError = responseData?.message || statusText || 'Unknown error';

  return { status, statusText, apiError };
}

function createApiError(userMessage: string, apiError: string): Error {
  return new Error(`${userMessage}\nAPI Error: ${apiError}`);
}

function handleNetworkError(context: string): Error {
  return new Error(`Network error ${context}.\nPlease check your internet connection and try again.`);
}

function handleAxiosError(error: unknown, context: string, statusCodeHandlers: Record<number, (apiError: string) => Error>): never {
  const axiosError = error as AxiosError;

  if (axiosError.response) {
    const { status, apiError } = extractApiError(axiosError);
    const handler = statusCodeHandlers[status];

    if (handler) {
      throw handler(apiError);
    } else {
      const { statusText } = extractApiError(axiosError);
      throw createApiError(
        `${context} failed (HTTP ${status} ${statusText}).\nPlease contact support if this issue persists.`,
        apiError
      );
    }
  } else if (axiosError.request) {
    throw handleNetworkError(context);
  } else {
    throw new Error(`${context}: ${axiosError.message}`);
  }
}

export async function publish(client: AxiosInstance, projectID: string, path: string, targetChannel: string) {
  CliUx.ux.log(`Publishing to project ID: ${projectID}`);
  CliUx.ux.log(`Target channel: ${targetChannel}`);
  CliUx.ux.log(`Release path: ${path}`);

  // Fetch available channels for the project
  CliUx.ux.log('Fetching available release channels...');
  let channels: { channel_id: number, channel_name: string }[];

  try {
    const response = await client.get<{ channel_id: number, channel_name: string }[]>(`/api/v1/channels?project_id=${projectID}`);
    channels = response.data;

    if (!Array.isArray(channels)) {
      throw new Error('Invalid response format: expected array of channels');
    }

    CliUx.ux.log(`Found ${channels.length} available channels: ${channels.map(c => c.channel_name).join(', ')}`);

  } catch (error) {
    handleAxiosError(error, 'Error fetching channels', {
      404: (apiError) => createApiError(
        `Project not found. Please verify your project ID: ${projectID}\nMake sure the project exists and you have access to it.`,
        apiError
      ),
      403: (apiError) => createApiError(
        `Access denied to project ${projectID}.\nPlease check that your account has permission to access this project.`,
        apiError
      ),
      401: (apiError) => createApiError(
        'Authentication failed. Please verify your private key and try again.',
        apiError
      )
    });
  }

  // Find the target channel
  const releaseChannel = channels.find((channel) => targetChannel === channel.channel_name);

  if (!releaseChannel) {
    const availableChannels = channels.map(c => c.channel_name).join(', ');
    throw new Error(`Release channel "${targetChannel}" not found on this project.\n` +
      `Available channels: ${availableChannels}\n` +
      `Please use --channel flag with one of the available channel names.`);
  }

  CliUx.ux.log(`Using channel: ${releaseChannel.channel_name} (ID: ${releaseChannel.channel_id})`);

  // Submit release for review
  CliUx.ux.log('Submitting release for review...');

  try {
    await client.post("/api/v1/reviews/release", {
      path,
      channel_id: releaseChannel.channel_id,
    });

    CliUx.ux.log(`✅ Successfully submitted release for review on channel "${targetChannel}"`);

  } catch (error) {
    handleAxiosError(error, 'Release submission', {
      400: (apiError) => createApiError(
        'Invalid request data.\nPlease check your release configuration.',
        apiError
      ),
      404: (apiError) => createApiError(
        'Release submission endpoint not found.\nThis may indicate an API version mismatch or the endpoint has changed.',
        apiError
      ),
      403: (apiError) => createApiError(
        'Access denied for release submission.\nPlease verify you have permission to publish releases on this project.',
        apiError
      ),
      401: (apiError) => createApiError(
        'Authentication expired. Please re-authenticate and try again.',
        apiError
      ),
      409: (apiError) => createApiError(
        'Release conflict: A release with this configuration may already exist.',
        apiError
      ),
      422: (apiError) => createApiError(
        'Release validation failed.\nPlease check your release files and metadata.',
        apiError
      )
    });
  }
}
