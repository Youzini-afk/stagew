import { sendOtp, verifyOtp } from './auth.js';
import { addAccount } from './account-pool.js';
import * as gptmail from './gptmail.js';

/**
 * 自动注册 Stagewise 账号
 *
 * 流程：
 * 1. 通过 GPTMail 创建临时邮箱
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
    onProgress = () => {},
  } = opts;

  // Step 1: 创建临时邮箱
  onProgress('creating-mailbox', '正在创建临时邮箱 (GPTMail)...');
  let mailbox;
  try {
    const rand = prefix || 'sw' + Math.random().toString(36).substring(2, 10);
    mailbox = await gptmail.createMailbox(rand);
  } catch (err) {
    throw new Error(`创建邮箱失败: ${err.message}`);
  }

  const email = mailbox.email;
  onProgress('mailbox-created', `邮箱已创建: ${email}`);

  // Step 2: 发送 Stagewise OTP
  onProgress('sending-otp', '正在发送验证码...');
  const otpResult = await sendOtp(email);
  if (!otpResult.success) {
    throw new Error(`发送 OTP 失败: ${otpResult.error}`);
  }
  onProgress('otp-sent', '验证码已发送，等待邮件...');

  // Step 3: 轮询获取验证码
  onProgress('waiting-code', '正在等待验证码邮件...');
  let code;
  try {
    const result = await gptmail.waitForVerificationCode(email, {
      maxWait,
      senderFilter: 'stagewise',
    });
    code = result.code;
  } catch (err) {
    throw new Error(`获取验证码失败: ${err.message}`);
  }
  onProgress('code-received', `验证码: ${code}`);

  // Step 4: 验证 OTP
  onProgress('verifying', '正在验证...');
  const verifyResult = await verifyOtp(email, code);
  if (!verifyResult.success) {
    throw new Error(`验证失败: ${verifyResult.error}`);
  }
  const token = verifyResult.token;
  onProgress('verified', '验证成功，获取到 Token');

  // Step 5: 加入账号池
  if (addToPool) {
    onProgress('adding-pool', '正在加入账号池...');
    const account = addAccount(email, token, '自动注册 (GPTMail)');
    onProgress('done', '注册完成，已加入账号池');
    return { success: true, email, token, account };
  }

  onProgress('done', '注册完成');
  return { success: true, email, token };
}
