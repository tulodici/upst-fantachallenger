// Codici nazione IOC (come restituiti da SportsAPI365, es. "GBR") -> emoji bandiera. Se il codice non e' noto resta il testo.
const IOC_TO_ISO2 = {
  AFG: 'AF', ALB: 'AL', ALG: 'DZ', AND: 'AD', ANG: 'AO', ARG: 'AR', ARM: 'AM', ARU: 'AW', AUS: 'AU', AUT: 'AT', AZE: 'AZ',
  BAH: 'BS', BAN: 'BD', BAR: 'BB', BDI: 'BI', BEL: 'BE', BEN: 'BJ', BER: 'BM', BIH: 'BA', BLR: 'BY', BOL: 'BO', BOT: 'BW',
  BRA: 'BR', BRN: 'BH', BUL: 'BG', BUR: 'BF', CAM: 'KH', CAN: 'CA', CGO: 'CG', CHI: 'CL', CHN: 'CN', CIV: 'CI', CMR: 'CM',
  COD: 'CD', COL: 'CO', CRC: 'CR', CRO: 'HR', CUB: 'CU', CYP: 'CY', CZE: 'CZ', DEN: 'DK', DJI: 'DJ', DOM: 'DO', ECU: 'EC',
  EGY: 'EG', ESA: 'SV', ESP: 'ES', EST: 'EE', ETH: 'ET', FIN: 'FI', FRA: 'FR', GAB: 'GA', GBR: 'GB', GEO: 'GE', GER: 'DE',
  GHA: 'GH', GRE: 'GR', GRN: 'GD', GUA: 'GT', GUM: 'GU', HAI: 'HT', HKG: 'HK', HON: 'HN', HUN: 'HU', INA: 'ID', IND: 'IN',
  IRI: 'IR', IRL: 'IE', IRQ: 'IQ', ISL: 'IS', ISR: 'IL', ISV: 'VI', ITA: 'IT', JAM: 'JM', JOR: 'JO', JPN: 'JP', KAZ: 'KZ',
  KEN: 'KE', KGZ: 'KG', KOR: 'KR', KOS: 'XK', KSA: 'SA', KUW: 'KW', LAT: 'LV', LBA: 'LY', LBN: 'LB', LIE: 'LI', LTU: 'LT',
  LUX: 'LU', MAD: 'MG', MAR: 'MA', MAS: 'MY', MDA: 'MD', MEX: 'MX', MGL: 'MN', MKD: 'MK', MLT: 'MT', MNE: 'ME', MON: 'MC',
  MOZ: 'MZ', MRI: 'MU', NAM: 'NA', NCA: 'NI', NED: 'NL', NEP: 'NP', NGR: 'NG', NOR: 'NO', NZL: 'NZ', OMA: 'OM', PAK: 'PK',
  PAN: 'PA', PAR: 'PY', PER: 'PE', PHI: 'PH', PLE: 'PS', POL: 'PL', POR: 'PT', PUR: 'PR', QAT: 'QA', ROU: 'RO', RSA: 'ZA',
  RUS: 'RU', RWA: 'RW', SEN: 'SN', SGP: 'SG', SLO: 'SI', SMR: 'SM', SRB: 'RS', SRI: 'LK', SUI: 'CH', SVK: 'SK', SWE: 'SE',
  SYR: 'SY', THA: 'TH', TJK: 'TJ', TKM: 'TM', TOG: 'TG', TPE: 'TW', TTO: 'TT', TUN: 'TN', TUR: 'TR', UAE: 'AE', UGA: 'UG',
  UKR: 'UA', URU: 'UY', USA: 'US', UZB: 'UZ', VEN: 'VE', VIE: 'VN', ZAM: 'ZM', ZIM: 'ZW',
};

export function flag(code) {
  if (!code) return '';
  const raw = String(code).trim().toUpperCase();
  const iso = IOC_TO_ISO2[raw] ?? (raw.length === 2 ? raw : null);
  if (!iso) return raw;
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
