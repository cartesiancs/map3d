// The UI is English only. OSM data carries names in every language, so text shown from it goes through here.

/** any letter outside the Latin script (Hangul, Han, Kana, Cyrillic, Arabic, Greek, …) */
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/** Latin-script text only (accented Latin like "São Paulo" is fine); empty / non-Latin → false */
export function isEnglishText(s: string | undefined | null): s is string {
  return !!s && s.trim() !== "" && !NON_LATIN.test(s);
}

/** The English name of an OSM feature: name:en first, then the plain name when it is in Latin script. */
export function englishName(tags: Record<string, string>): string | null {
  for (const key of ["name:en", "official_name:en", "short_name:en", "name", "addr:housename"]) {
    if (isEnglishText(tags[key])) return tags[key].trim();
  }
  return null;
}

/**
 * Name variants are other languages by definition (name:ko, alt_name:ja, …): never shown,
 * except the English ones.
 */
export function isForeignNameKey(key: string) {
  return /^(name|alt_name|old_name|official_name|short_name|loc_name|int_name|reg_name|nat_name|long_name)(:|$)/.test(key) && !key.endsWith(":en");
}
