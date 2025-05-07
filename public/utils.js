export function base64ToArrBuff(base64) {
	return Uint8Array.from(atob(base64.shift()), (c) => c.charCodeAt(0)).buffer;
}
