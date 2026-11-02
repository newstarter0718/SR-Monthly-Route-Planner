import { GoogleGenAI } from '@google/genai';
import { ExternalAccountClient } from 'google-auth-library';
import { getVercelOidcToken } from '@vercel/oidc';

export function createVertexAi(project: string, location: string): GoogleGenAI {
  const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
  const useOidc = Boolean(process.env.VERCEL || poolId);
  if (!useOidc) {
    console.info('[Vertex Auth]', JSON.stringify({ mode: 'adc', project, location }));
    return new GoogleGenAI({ vertexai: true, project, location });
  }

  const projectNumber = process.env.GCP_PROJECT_NUMBER;
  const providerId = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
  const serviceAccount = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
  if (!poolId || !projectNumber || !providerId || !serviceAccount) {
    throw new Error('Missing required GCP workload identity configuration');
  }

  // STS audience identifies the GCP provider; the JWT aud is validated by that provider.
  const authClient = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() },
  });
  if (!authClient) throw new Error('Failed to build workload identity client');
  console.info('[Vertex Auth]', JSON.stringify({ mode: 'vercel-oidc', project, location }));
  return new GoogleGenAI({ vertexai: true, project, location, googleAuthOptions: { authClient } });
}
