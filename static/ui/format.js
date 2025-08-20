export function bytesToLabel(bytes) {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(0)} KB`;
    return `${(bytes/1024/1024).toFixed(2)} MB`;
}


