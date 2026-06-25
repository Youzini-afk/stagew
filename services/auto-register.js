import { sendOtp, verifyOtp } from './auth.js';
import { addAccount } from './account-pool.js';
import * as mailProvider from './mail-provider.js';

function createAbortError() {
  const err = new Error('注册已停止');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

/**
 * 自动注册 Stagewise 账号
 *
 * 流程：
 * 1. 通过当前临时邮箱 Provider 创建临时邮箱
 * 2. 向 Stagewise 发送 OTP 验证码
 * 3. 轮询收件箱获取验证码
 * 4. 提交验证码完成登录，获取 token
 * 5. 将账号加入账号池
 */
export async function autoRegister(opts = {}) {
  const {
    prefix,
    addToPool = true,
    maxWait = 60000,
    signal,
    dispatcher,
    proxyLabel,
    onProgress = () => {},
  } = opts;

  const providerName = mailProvider.getMailProviderName();
  const providerLabel = mailProvider.getMailProviderLabel();

  // Step 1: 创建临时邮箱
  throwIfAborted(signal);
  onProgress('creating-mailbox', `正在创建临时邮箱 (${providerLabel})...`);
  let mailbox;
  try {
    const rand = prefix || 'sw' + Math.random().toString(36).substring(2, 10);
    mailbox = await mailProvider.createMailbox(rand, null, { signal, dispatcher });
    throwIfAborted(signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`创建邮箱失败: ${err.message}`);
  }

  const email = mailbox.email;
  const via = proxyLabel ? ` · 代理 ${proxyLabel}` : '';
  onProgress('mailbox-created', `邮箱已创建: ${email}${via}`);

  // Step 2: 发送 Stagewise OTP
  throwIfAborted(signal);
  onProgress('sending-otp', '正在发送验证码...');
  const otpResult = await sendOtp(email, 'sign-in', { signal, dispatcher });
  throwIfAborted(signal);
  if (!otpResult.success) {
    throw new Error(`发送 OTP 失败: ${otpResult.error}`);
  }
  onProgress('otp-sent', '验证码已发送，等待邮件...');

  // Step 3: 轮询获取验证码
  throwIfAborted(signal);
  onProgress('waiting-code', '正在等待验证码邮件...');
  let code;
  try {
    const result = await mailProvider.waitForVerificationCode(mailbox, {
      maxWait,
      senderFilter: 'stagewise',
      signal,
      dispatcher,
    });
    throwIfAborted(signal);
    code = result.code;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`获取验证码失败: ${err.message}`);
  }
  onProgress('code-received', `验证码: ${code}`);

  // Step 4: 验证 OTP
  throwIfAborted(signal);
  onProgress('verifying', '正在验证...');
  const verifyResult = await verifyOtp(email, code, { signal, dispatcher });
  throwIfAborted(signal);
  if (!verifyResult.success) {
    throw new Error(`验证失败: ${verifyResult.error}`);
  }
  const token = verifyResult.token;
  onProgress('verified', '验证成功，获取到 Token');

  // Step 5: 加入账号池
  if (addToPool) {
    throwIfAborted(signal);
    onProgress('adding-pool', '正在加入账号池...');
    const account = addAccount(email, token, `自动注册 (${providerLabel})`);
    onProgress('done', '注册完成，已加入账号池');
    return { success: true, email, token, account, provider: providerName };
  }

  onProgress('done', '注册完成');
  return { success: true, email, token, provider: providerName };
}
