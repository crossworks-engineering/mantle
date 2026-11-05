/**
 * The SCIM discovery documents (RFC 7643 sections 5 to 7, RFC 7644 section
 * 4): what the box serves, for a provider that reads them first. One
 * resource type, User; no groups, no bulk, no sort, no change of password.
 */
import { LIST_MAX, SCIM_LIST, SCIM_USER } from './shapes';

const SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export function serviceProviderConfig(base: string) {
  return {
    schemas: [SPC],
    documentationUri: 'https://docs.mantle-ai.tech',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: LIST_MAX },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'The box token, sent as Authorization: Bearer <token>.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

const userResourceType = (base: string) => ({
  schemas: [RESOURCE_TYPE],
  id: 'User',
  name: 'User',
  endpoint: '/Users',
  description: 'A Mantle login',
  schema: SCIM_USER,
  meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
});

const attr = (
  name: string,
  over: Partial<Record<'type' | 'mutability' | 'uniqueness' | 'returned', string>> & {
    required?: boolean;
    caseExact?: boolean;
    multiValued?: boolean;
    subAttributes?: unknown[];
  } = {},
) => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...over,
});

const userSchema = (base: string) => ({
  schemas: [SCHEMA],
  id: SCIM_USER,
  name: 'User',
  description: 'A Mantle login. userName is its email, kept as it was made.',
  attributes: [
    attr('userName', { required: true, uniqueness: 'server', mutability: 'immutable' }),
    attr('displayName'),
    attr('name', { type: 'complex', subAttributes: [attr('formatted')] }),
    attr('active', { type: 'boolean' }),
    attr('externalId', { caseExact: true }),
    attr('emails', {
      type: 'complex',
      multiValued: true,
      mutability: 'readOnly',
      subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })],
    }),
  ],
  meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM_USER}` },
});

export function resourceTypes(base: string) {
  const r = [userResourceType(base)];
  return {
    schemas: [SCIM_LIST],
    totalResults: r.length,
    startIndex: 1,
    itemsPerPage: r.length,
    Resources: r,
  };
}

export function schemas(base: string) {
  const r = [userSchema(base)];
  return {
    schemas: [SCIM_LIST],
    totalResults: r.length,
    startIndex: 1,
    itemsPerPage: r.length,
    Resources: r,
  };
}
