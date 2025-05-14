export function base64ToArrBuff(base64Str) {
	return Uint8Array.from(atob(base64Str), (c) => c.charCodeAt(0)).buffer;
}
