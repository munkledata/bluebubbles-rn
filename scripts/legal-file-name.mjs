const LEADING_LEGAL_NAME = /^(?:licen[cs]es?|copying|notices?|copyright|patents?)(?:[._ -].*)?$/i;
const SUFFIXED_LEGAL_NAME =
  /.+[._ -](?:licen[cs]es?|copying|notices?|copyright|patents?)(?:\.(?:txt|text|md|markdown|rst|html?))?$/i;
const THIRD_PARTY_LEGAL_NAME =
  /^third[-_. ]?party(?:(?:[-_. ]?(?:licen[cs]es?|notices?|copyright|attributions?)(?:[-_. ]?text)?)(?:[._ -](?:txt|text|md|markdown|rst|html?|json|xml))?|[._ -](?:txt|text|md|markdown|rst|html?|json|xml))?$/i;

export function isLegalFileName(name) {
  return (
    LEADING_LEGAL_NAME.test(name) ||
    SUFFIXED_LEGAL_NAME.test(name) ||
    THIRD_PARTY_LEGAL_NAME.test(name)
  );
}
