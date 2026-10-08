// Escolhe o serviço de vídeo pela variável VIDEO_PROVIDER: "gemini" (padrão, Veo) ou "hailuo" (MiniMax).
const name = (process.env.VIDEO_PROVIDER || 'gemini').toLowerCase();
const mod = await import(name === 'hailuo' ? './hailuo.js' : './video.js');
export const provider = name === 'hailuo' ? 'hailuo' : 'gemini';
export const { isConfigured, modelName, listModels, start, status, file, range } = mod;
