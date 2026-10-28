export interface CacheEntry<T> {
  key: string;
  value: T;
  sizeBytes: number;
  lastAccessed: number;
}

/**
 * Cache LRU (Least Recently Used) com limite de quantidade de itens
 * e teto de consumo de memória em bytes para miniaturas de cartazes.
 */
export class LruThumbnailCache {
  private cache = new Map<string, CacheEntry<string>>();
  private currentBytes = 0;
  private maxItems: number;
  private maxBytes: number;

  constructor(maxItems = 100, maxBytes = 25 * 1024 * 1024) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    entry.lastAccessed = Date.now();
    // Reinsere para manter a ordem de acesso recente no Map
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    if (!key || !value) return;

    // Estima o tamanho da string em bytes (UTF-16 no JS: 2 bytes por caractere)
    const sizeBytes = value.length * 2;

    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.currentBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }

    // Se o item sozinho excede o teto máximo, não armazena para não estourar a cota
    if (sizeBytes > this.maxBytes) {
      return;
    }

    // Ejetar itens antigos enquanto exceder limites
    while (
      (this.cache.size >= this.maxItems || this.currentBytes + sizeBytes > this.maxBytes) &&
      this.cache.size > 0
    ) {
      this.evictOldest();
    }

    this.cache.set(key, {
      key,
      value,
      sizeBytes,
      lastAccessed: Date.now(),
    });
    this.currentBytes += sizeBytes;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentBytes -= entry.sizeBytes;
      return this.cache.delete(key);
    }
    return false;
  }

  clear(): void {
    this.cache.clear();
    this.currentBytes = 0;
  }

  size(): number {
    return this.cache.size;
  }

  bytes(): number {
    return this.currentBytes;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.currentBytes -= entry.sizeBytes;
      }
      this.cache.delete(oldestKey);
    }
  }
}

// Instância global compartilhada de cache de miniaturas
export const globalThumbnailCache = new LruThumbnailCache(120, 25 * 1024 * 1024);

/**
 * Cria uma miniatura otimizada e leve (máx ~160x226 px) a partir de um canvas ou data URL,
 * ocupando ~15 KB a 30 KB ao invés dos ~10 MB da composição integral.
 */
export async function createOptimizedThumbnail(
  sourceDataUrl: string,
  maxWidth = 160,
  maxHeight = 226
): Promise<string> {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined' ||
    !sourceDataUrl
  ) {
    return sourceDataUrl;
  }

  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ratio = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
      canvas.width = Math.max(1, Math.round(img.width * ratio));
      canvas.height = Math.max(1, Math.round(img.height * ratio));

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const thumb = canvas.toDataURL('image/jpeg', 0.82);
        // Libera imediatamente o canvas
        canvas.width = 0;
        canvas.height = 0;
        resolve(thumb);
      } else {
        resolve(sourceDataUrl);
      }
    };
    img.onerror = () => resolve(sourceDataUrl);
    img.src = sourceDataUrl;
  });
}

