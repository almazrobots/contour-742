// Presentation/export policy. Original append-only operator labels stay intact.
const profanity=/(?<![\p{L}\p{N}])(?:[а-яё]*пизд[а-яё]*|(?:на|по|ни|до|о)?ху[йяеёию][а-яё]*|(?:под|за|вы|на|от|до|по|пере|раз|про|с|у|об)?[её]б[аулныоёеи][а-яё]*|долбо[её]б[а-яё]*|бля[дт]?[а-яё]*|су(?:ка|ки|ку|ке|кой)|fuck[a-z]*|shit)(?![\p{L}\p{N}])/giu;
export function censorAnnotationComment(comment:string):string {
  return comment.replace(profanity,word=>'*'.repeat(word.length));
}
