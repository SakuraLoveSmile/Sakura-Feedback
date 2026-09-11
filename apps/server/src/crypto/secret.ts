import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM。密文格式: v1:<iv b64>:<tag b64>:<ct b64> */
export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(masterKey: Buffer, packed: string): string {
  const [v, iv, tag, ct] = packed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("密文格式错误");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
