/**
 * SecureStorage - 凭据加密存储工具
 * 使用 AES-GCM 加密敏感字段，密钥从 vault 名称 PBKDF2 派生
 */

const ENC_PREFIX = "enc:v1:";

// 需要加密的敏感字段
export const SENSITIVE_FIELDS = [
	"githubToken",
	"aliyunAccessKeyId",
	"aliyunAccessKeySecret",
	"tencentSecretId",
	"tencentSecretKey",
	"smmsToken",
	"webdavPassword",
] as const;

function isEncrypted(value: string): boolean {
	return value.startsWith(ENC_PREFIX);
}

async function deriveKey(salt: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("ImageLMgr-v1"),
		"PBKDF2",
		false,
		["deriveKey"]
	);

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: new TextEncoder().encode(salt),
			iterations: 100000,
			hash: "SHA-256",
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

async function encryptValue(plaintext: string, key: CryptoKey): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext)
	);

	const combined = new Uint8Array(iv.length + encrypted.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(encrypted), iv.length);

	return ENC_PREFIX + btoa(String.fromCharCode(...combined));
}

async function decryptValue(ciphertext: string, key: CryptoKey): Promise<string> {
	const raw = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
	const iv = raw.slice(0, 12);
	const data = raw.slice(12);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		data
	);

	return new TextDecoder().decode(decrypted);
}

/**
 * 加密设置中的敏感字段
 */
export async function encryptSensitiveFields(
	settings: Record<string, any>,
	deviceSalt: string,
): Promise<Record<string, any>> {
	const key = await deriveKey(deviceSalt);
	const result = { ...settings };

	for (const field of SENSITIVE_FIELDS) {
		const value = result[field];
		if (typeof value === "string" && value && !isEncrypted(value)) {
			result[field] = await encryptValue(value, key);
		}
	}

	return result;
}

/**
 * 解密设置中的敏感字段（自动跳过未加密值，兼容旧数据）
 */
export async function decryptSensitiveFields(
	settings: Record<string, any>,
	deviceSalt: string,
): Promise<Record<string, any>> {
	const key = await deriveKey(deviceSalt);
	const result = { ...settings };

	for (const field of SENSITIVE_FIELDS) {
		const value = result[field];
		if (typeof value === "string" && isEncrypted(value)) {
			try {
				result[field] = await decryptValue(value.slice(ENC_PREFIX.length), key);
			} catch {
				console.warn(`[ImageLMgr] 解密字段 ${field} 失败，已清空`);
				result[field] = "";
			}
		}
	}

	return result;
}
