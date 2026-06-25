import { getMailProviderName as getConfiguredMailProviderName } from './settings.js';
import * as gptmail from './gptmail.js';
import * as cfmail from './cfmail.js';

const providers = {
  gptmail,
  cfmail,
};

const providerLabels = {
  gptmail: 'GPTMail',
  cfmail: 'CFMail',
};

function getProviderModule() {
  const provider = getConfiguredMailProviderName();
  return providers[provider] || providers.gptmail;
}

export function getMailProviderName() {
  return getConfiguredMailProviderName();
}

export function getMailProviderLabel() {
  const provider = getMailProviderName();
  return providerLabels[provider] || provider;
}

export async function createMailbox(prefix = null, domain = null) {
  const provider = getProviderModule();
  const mailbox = await provider.createMailbox(prefix, domain);
  return { ...mailbox, provider: getMailProviderName() };
}

export async function getDomains() {
  return getProviderModule().getDomains();
}

export async function waitForVerificationCode(mailboxOrObject, opts = {}) {
  return getProviderModule().waitForVerificationCode(mailboxOrObject, opts);
}

export async function getEmails(mailboxOrObject, limit = 20) {
  return getProviderModule().getEmails(mailboxOrObject, limit);
}

export async function checkHealth() {
  const provider = getProviderModule();
  if (typeof provider.checkHealth === 'function') {
    return provider.checkHealth();
  }
  const domains = await provider.getDomains();
  return { ok: true, domains };
}
