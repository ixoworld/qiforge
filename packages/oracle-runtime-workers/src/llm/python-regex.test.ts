import { describe, expect, it } from 'vitest';
import { pythonRegexRefusal } from './python-regex';

/**
 * Every pattern here was sent to `openai/gpt-5.6-luna` on OpenRouter on
 * 2026-11-13 as the `pattern` of a function parameter, with the provider
 * pinned to OpenAI (and, for the first 49, also to Azure, which agreed on
 * each). `true` = the provider answered 200, `false` = HTTP 400
 * `invalid_function_parameters`.
 */
const MEASURED: ReadonlyArray<readonly [string, string, boolean]> = [
  ['yo_unicode_prop', "^[\\p{L}\\p{M}\\s'-]+$", false],
  ['neg_unicode_prop', '^\\P{L}+$', false],
  ['unicode_prop_long', '^\\p{Letter}+$', false],
  ['script_prop', '^\\p{Script=Latin}+$', false],
  ['control', '^[a-z]+$', true],
  ['js_named_group', '^(?<word>[a-z]+)$', false],
  ['py_named_group', '^(?P<word>[a-z]+)$', true],
  ['js_named_backref', '^(?<w>a)\\k<w>$', false],
  ['lookahead', '^(?=.*\\d)[a-z0-9]+$', true],
  ['neg_lookahead', '^(?!x)[a-z]+$', true],
  ['lookbehind_fixed', '^a(?<=a)b$', true],
  ['neg_lookbehind', '^(?<!x)[a-z]+$', true],
  ['lookbehind_variable', '(?<=a+)b', false],
  ['backref', '^([a-z])\\1$', true],
  ['unicode_4hex', '^é+$', true],
  ['unicode_braces', '^\\u{1F600}$', false],
  ['hex_escape', '^\\x41$', true],
  ['control_escape', '^\\cJ$', false],
  ['js_any_class', '^[^]*$', false],
  ['empty_class', '^[]a$', false],
  ['possessive', '^a++$', true],
  ['atomic', '^(?>a)b$', true],
  ['inline_flag', '(?i)^abc$', true],
  ['inline_flag_scoped', '^(?i:abc)$', true],
  ['posix_class', '^[[:alpha:]]+$', true],
  ['esc_e', '^\\e$', false],
  ['anchor_A_Z', '\\Aabc\\Z', true],
  ['esc_slash', '^\\/path$', true],
  ['esc_hyphen_class', '^[\\w.+\\-]+$', true],
  ['email_like', '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', true],
  [
    'zod_email',
    "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
    true,
  ],
  [
    'uuid_like',
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    true,
  ],
  ['ascii_neg_class', '^[^0-9!-&(-,./:-@\\[-`{-~]+$', true],
  ['lazy', '^a+?b$', true],
  ['esc_d_class', '^[\\d\\s]+$', true],
  ['bad_escape_q', '^\\q$', false],
  ['esc_digit_0', '^\\0$', true],
  ['octal_like', '^\\012$', true],
  ['esc_b_in_class', '^[\\b]$', true],
  ['unicode_surrogate', '^😀$', true],
  ['var_lookbehind_alt', '(?<=ab|c)d', false],
  ['conditional', '^(a)?(?(1)b|c)$', true],
  ['comment_group', '^a(?#note)b$', true],
  ['quantifier_brace_open', '^a{,3}$', true],
  ['literal_brace', '^a{b$', true],
  ['dollar_end', '^abc$', true],
  ['nested_quant', '^(a+)+$', true],
  ['unicode_literal', '^[À-ÿ]+$', true],
  ['emoji_prop', '^\\p{Extended_Pictographic}$', false],
  ['mid_global_flag', '^a(?i)b$', false],
  ['range_class_escape', '^[\\d-z]$', false],
  ['reversed_range', '^[z-a]$', false],
  ['multiple_repeat', '^a**$', false],
  ['bad_group_name', '^(?P<1a>x)$', false],
  ['named_unicode', '^\\N{LATIN SMALL LETTER A}$', true],
  ['k_no_group', '^\\k<w>$', false],
  ['bracket_first', '^[]a]$', true],
  ['backref_missing', '^\\8$', false],
  ['backref_later', '^(a)\\2$', false],
  ['min_gt_max', '^x{2,1}$', false],
  ['nothing_to_repeat', '^*a$', false],
  ['unbalanced', '^(a$', false],
  ['upper_U', '^\\U0001F600$', true],
  ['x_short', '^\\x4$', false],
  ['esc_A_in_class', '^[\\A]$', false],
  ['esc_Z_in_class', '^[\\Z]$', true],
  ['esc_B_in_class', '^[\\B]$', false],
  ['esc_N_short', '^\\N$', false],
  ['dash_end', '^[a-]$', true],
  ['caret_class', '^[\\^a]$', true],
  ['esc_dot_class', '^[\\.]$', true],
  ['esc_slash_class', '^[\\/]$', true],
  ['esc_space', '^a\\ b$', true],
  ['esc_colon', '^a\\:b$', true],
  ['esc_quote', "^a\\'b$", true],
  ['lookahead_in_lookbehind', '(?<=(?=a)b)c', true],
  ['lookbehind_fixed_quant', '(?<=a{2})b', true],
  ['lookbehind_alt_same', '(?<=ab|cd)e', true],
  ['lookbehind_class', '(?<=[a-z]\\d)x', true],
];

describe('pythonRegexRefusal', () => {
  it.each(MEASURED)(
    '%s: %s (accepted by OpenAI: %s)',
    (_name, pattern, accepted) => {
      expect(pythonRegexRefusal(pattern) === null).toBe(accepted);
    },
  );

  it('refuses the Yo language pattern for its Unicode property escape', () => {
    expect(pythonRegexRefusal("^[\\p{L}\\p{M}\\s'-]+$")).toBe('bad escape \\p');
  });

  it.each([
    ['^\\u00e9+$', null],
    ['^\\u00e$', 'incomplete escape \\u00e'],
    ['^[\\u0041-\\u005a]$', null],
    ['^[\\u005a-\\u0041]$', 'bad character range'],
    ['^(a)\\1$', null],
    ['^(a\\1)$', 'cannot refer to an open group'],
    ['^(?P<n>a)(?P=n)$', null],
    ['^(?P<n>a)(?P<n>b)$', 'redefinition of group name'],
    ['^\\123$', null],
    ['^\\400$', 'octal escape value outside of range 0-0o377'],
    ['(?x) a b', null],
    ['^[a\\-z]$', null],
    ['^a{2}?$', null],
    ['^a{2}{3}$', 'multiple repeat'],
    ['^\\z$', 'bad escape \\z'],
  ] as const)('%s', (pattern, refusal) => {
    expect(pythonRegexRefusal(pattern)).toBe(refusal);
  });
});
