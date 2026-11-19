/** 生成全局唯一 ID（crypto.randomUUID 为 Web 标准 API，Node/浏览器均可用） */
export function newId(): string {
  return crypto.randomUUID();
}
