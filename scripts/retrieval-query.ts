const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "can", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "about", "how", "what", "where", "when", "who",
  "why", "which", "that", "this", "it", "its", "me", "my", "we", "our", "you", "your", "he",
  "she", "they", "them", "and", "but", "or", "if", "so", "up", "out", "no", "not", "just",
  "get", "got", "let", "going", "doing",
]);

export function extractKeywordsFromMessage(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
