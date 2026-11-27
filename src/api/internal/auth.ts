import { z } from "zod";
import { BztError } from "../../core/errors.ts";

const loginResponse = z.object({ token: z.string().min(1) });
type Session = Readonly<{ token: string }>;

export function authFailed(): BztError {
  return new BztError(
    "AUTH_FAILED",
    "禅道认证失败。请运行 bzt doctor 检查配置。",
  );
}

function decodeSession(text: string): Session {
  try {
    const raw: unknown = JSON.parse(text);
    const { token } = loginResponse.parse(raw);
    // 检查 Fetch 实际发送的头值，避免无效凭据落入网络重试。
    if (new Headers({ Token: token }).get("Token") === token) return { token };
  } catch {
    // 解码异常可能携带认证响应或凭据。
  }
  throw authFailed();
}

export function createZentaoAuth(login: () => Promise<string>) {
  let current: Session | undefined;
  let pending: Promise<Session> | undefined;

  async function getSession(): Promise<Session> {
    if (current) return current;
    pending ??= login()
      .then((text) => {
        current = decodeSession(text);
        return current;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  function invalidate(rejected: Session): void {
    // 比较登录批次，禅道可能返回相同的 Token 文本。
    if (current === rejected) current = undefined;
  }

  /** ADR-22 Token-only：注入静态 Token，失败后由 invalidate 失效。 */
  function seedSession(token: string): void {
    if (current) return;
    current = { token };
  }

  function clearSession(): void {
    current = undefined;
  }

  return { getSession, invalidate, seedSession, clearSession };
}
