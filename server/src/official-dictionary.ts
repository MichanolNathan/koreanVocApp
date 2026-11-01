/**
 * Dictionnaire officiel intégré (v1.1.1) : 44 mots et expressions coréens de
 * niveau débutant, dérivés du deck Anki « First_500_Korean_Words.apkg »
 * (44 notes réellement présentes). Les gloses anglaises du deck ont été
 * traduites en français ; la coquille 우여히 corrigée en 우연히 ; le HTML
 * d'un champ nettoyé.
 *
 * Contrairement à la bibliothèque de phrases (contenu sans UI d'édition, mis
 * à jour par upsert), les mots sont modifiables et supprimables dans l'app :
 * le chargeur ne fait qu'INSÉRER les mots jamais livrés ni présents, et
 * consigne chaque livraison dans `shipped_words`. Une suppression reste donc
 * effective (le registre fait office de tombstone) et aucune édition
 * utilisateur n'est jamais écrasée — les mises à jour de l'application
 * n'ajoutent que de nouveaux mots.
 */
import type { DB } from './db.ts';

export interface OfficialWordSeed {
  korean: string;
  romanization?: string;
  pos?: string;
  translation: string;
  alts?: string[];
  hint?: string;
}

export const OFFICIAL_DICTIONARY: OfficialWordSeed[] = [
  { korean: '회사원', romanization: 'hoesawon', pos: 'nom', translation: 'employé de bureau' },
  { korean: '나', romanization: 'na', pos: 'pronom', translation: 'moi', alts: ['je'], hint: 'forme familière' },
  { korean: '너무', romanization: 'neomu', pos: 'adverbe', translation: 'trop', alts: ['très'] },
  { korean: '바쁘다', romanization: 'bappeuda', pos: 'verbe', translation: 'être occupé', alts: ['être affairé'] },
  { korean: '보통', romanization: 'botong', pos: 'adverbe', translation: 'd’habitude', alts: ['habituellement', 'ordinaire'] },
  { korean: '주말', romanization: 'jumal', pos: 'nom', translation: 'week-end' },
  { korean: '우리', romanization: 'uri', pos: 'pronom', translation: 'nous', alts: ['notre'] },
  { korean: '만나다', romanization: 'mannada', pos: 'verbe', translation: 'rencontrer', alts: ['se rencontrer'] },
  { korean: '영화', romanization: 'yeonghwa', pos: 'nom', translation: 'film' },
  { korean: '카페', romanization: 'kape', pos: 'nom', translation: 'café', alts: ['salon de café'], hint: 'l’établissement' },
  { korean: '저', romanization: 'jeo', pos: 'pronom', translation: 'moi', alts: ['je'], hint: 'forme polie/humble' },
  { korean: '제', romanization: 'je', pos: 'pronom', translation: 'moi', alts: ['je', 'mon'], hint: 'forme polie de 저 (je / mon)' },
  { korean: '내', romanization: 'nae', pos: 'pronom', translation: 'moi', alts: ['je', 'mon'], hint: 'forme familière de 나 (je / mon)' },
  { korean: '너', romanization: 'neo', pos: 'pronom', translation: 'toi', alts: ['tu'], hint: 'forme familière' },
  { korean: '회사', romanization: 'hoesa', pos: 'nom', translation: 'entreprise', alts: ['société'] },
  { korean: '일하다', romanization: 'ilhada', pos: 'verbe', translation: 'travailler' },
  { korean: '너무 바쁘다', romanization: 'neomu bappeuda', pos: 'expression', translation: 'être trop occupé' },
  { korean: '예쁘다', romanization: 'yeppeuda', pos: 'verbe', translation: 'être joli', alts: ['être beau', 'être belle'] },
  { korean: '요즘', romanization: 'yojeum', pos: 'adverbe', translation: 'ces derniers temps', alts: ['récemment', 'en ce moment'] },
  { korean: '요즘 바쁘다', romanization: 'yojeum bappeuda', pos: 'expression', translation: 'être occupé ces temps-ci' },
  { korean: '바쁜 사람', romanization: 'bappeun saram', pos: 'expression', translation: 'personne occupée', alts: ['personne affairée'] },
  { korean: '바쁘게', romanization: 'bappeuge', pos: 'adverbe', translation: 'avec empressement', alts: ['à la hâte'], hint: 'forme adverbiale de 바쁘다 (occupé)' },
  { korean: '한가하다', romanization: 'hangahada', pos: 'verbe', translation: 'être libre', alts: ['ne pas être occupé'] },
  { korean: '우리 집', romanization: 'uri jip', pos: 'expression', translation: 'chez nous', alts: ['notre maison'] },
  { korean: '보통 때', romanization: 'botong ttae', pos: 'expression', translation: 'd’habitude', alts: ['en temps normal'] },
  { korean: '보통 사람', romanization: 'botong saram', pos: 'expression', translation: 'personne ordinaire' },
  { korean: '이번 주말', romanization: 'ibeon jumal', pos: 'expression', translation: 'ce week-end' },
  { korean: '주말에', romanization: 'jumare', pos: 'expression', translation: 'le week-end', hint: '에 indique le moment' },
  { korean: '주말마다', romanization: 'jumalmada', pos: 'expression', translation: 'tous les week-ends', alts: ['chaque week-end'] },
  { korean: '쉬다', romanization: 'swida', pos: 'verbe', translation: 'se reposer', alts: ['faire une pause'] },
  { korean: '평일', romanization: 'pyeongil', pos: 'nom', translation: 'jour de semaine', alts: ['jour ouvrable'] },
  { korean: '우연히 만나다', romanization: 'uyeonhi mannada', pos: 'expression', translation: 'croiser par hasard', alts: ['rencontrer par hasard'] },
  { korean: '못 만나다', romanization: 'mot mannada', pos: 'expression', translation: 'ne pas pouvoir voir', alts: ['ne pas pouvoir rencontrer'] },
  { korean: '안 만나다', romanization: 'an mannada', pos: 'expression', translation: 'ne pas rencontrer', hint: '안 = négation' },
  { korean: '헤어지다', romanization: 'heeojida', pos: 'verbe', translation: 'se quitter', alts: ['se dire au revoir', 'se séparer'] },
  // Coquille du deck corrigée : « 우여히 » n’existe pas, c’est 우연히.
  { korean: '우연히', romanization: 'uyeonhi', pos: 'adverbe', translation: 'par hasard', alts: ['par accident'] },
  // Champ HTML dans le deck : « not able to (in front of verb) » une fois nettoyé.
  { korean: '못', romanization: 'mot', pos: 'adverbe', translation: 'ne pas pouvoir', hint: 'se place devant le verbe' },
  { korean: '영화를 보다', romanization: 'yeonghwareul boda', pos: 'expression', translation: 'regarder un film', alts: ['voir un film'] },
  { korean: '영화관', romanization: 'yeonghwagwan', pos: 'nom', translation: 'cinéma', alts: ['salle de cinéma'] },
  { korean: '주인공', romanization: 'juingong', pos: 'nom', translation: 'personnage principal', alts: ['protagoniste', 'héros'] },
  { korean: '영화배우', romanization: 'yeonghwabaeu', pos: 'nom', translation: 'acteur de cinéma', alts: ['actrice de cinéma'] },
  { korean: '카페에 가다', romanization: 'kapee gada', pos: 'expression', translation: 'aller au café' },
  { korean: '커피', romanization: 'keopi', pos: 'nom', translation: 'café', hint: 'la boisson' },
  { korean: '차', romanization: 'cha', pos: 'nom', translation: 'thé' },
];

/**
 * Livre le dictionnaire officiel : insère uniquement les mots dont le coréen
 * n'existe pas déjà (quelle que soit la source — un mot personnel homonyme
 * prime) et n'a jamais été livré. Retourne le nombre de mots ajoutés.
 */
export function loadOfficialDictionary(db: DB): number {
  return db.transaction(() => {
    const existing = new Set(
      (db.prepare('SELECT korean FROM words').all() as { korean: string }[]).map((r) => r.korean)
    );
    const delivered = new Set(
      (db.prepare('SELECT korean FROM shipped_words').all() as { korean: string }[]).map((r) => r.korean)
    );
    const insWord = db.prepare("INSERT INTO words (korean, romanization, pos, source) VALUES (?, ?, ?, 'official')");
    const insMeaning = db.prepare('INSERT INTO meanings (word_id, translation, hint) VALUES (?, ?, ?)');
    const insAlt = db.prepare('INSERT INTO meaning_translations (meaning_id, text) VALUES (?, ?)');
    const mark = db.prepare('INSERT INTO shipped_words (korean) VALUES (?)');
    let added = 0;
    for (const w of OFFICIAL_DICTIONARY) {
      if (existing.has(w.korean) || delivered.has(w.korean)) continue;
      const word = insWord.run(w.korean, w.romanization ?? null, w.pos ?? null);
      const meaning = insMeaning.run(Number(word.lastInsertRowid), w.translation, w.hint ?? null);
      for (const alt of w.alts ?? []) insAlt.run(Number(meaning.lastInsertRowid), alt);
      mark.run(w.korean);
      added++;
    }
    return added;
  });
}
