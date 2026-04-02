/**
 * dispersion.js - Club dispersion and ball-flight data access for Gordy.
 *
 * Rules for this module:
 *   - No DOM access, no localStorage, no global reads.
 *   - All state (hcp, yardType, yardMode) is threaded as arguments.
 *   - Depends only on geo.js and constants.js.
 */

import { flightKey, vizFlightKey, tierIndex, vizTierIdx } from './geo.js';
import { FLIGHT_DATA, BIAS_DATA, VIZ_ASYM, VIZ_LPROB, VIZ_ROLL, VIZ_LP } from './constants.js';

/**
 * Return a full dispersion data object for a club at a given handicap.
 * Used by the caddie session export path.
 *
 * @param {{ type: string, identifier?: string, bias?: string }} c
 * @param {number|null} hcp  Handicap index (pass getHandicap() from caller)
 * @returns {{
 *   key: string, spinRpm: number, launchDeg: number,
 *   latHalf: number, lateralOffset: number,
 *   depShort: number, depLong: number,
 *   spinCat: string, flight: string,
 *   tierLabel: string, bias: string
 * }|null}
 */
export function getDispersion(c, hcp) {
  const key = flightKey(c);
  if (!key) return null;
  const fd   = FLIGHT_DATA.clubs[key];
  const ti   = tierIndex(hcp);
  const bias = BIAS_DATA[c.bias || 'Straight'] || BIAS_DATA['Straight'];
  return {
    key,
    spinRpm:       fd.spinRpm[ti],
    launchDeg:     fd.launchDeg[ti],
    latHalf:       Math.round(fd.latDisp[ti] / 2 * bias.mult),
    lateralOffset: bias.offset,
    depShort:      fd.depShort[ti],
    depLong:       fd.depLong[ti],
    spinCat:       fd.spinCat,
    flight:        fd.flight,
    tierLabel:     FLIGHT_DATA.tiers[ti],
    bias:          c.bias || 'Straight'
  };
}

/**
 * Return a viz-ready dispersion object for a club, scaled to the active
 * yardage display mode (carry vs total).
 *
 * Previously read profile.yardType and vizYardMode from globals -- those are
 * now explicit parameters so this function is fully pure.
 *
 * @param {{ type: string, identifier?: string, loft?: number|string,
 *           bias?: string, sessions?: Array, yardType?: string }} c
 * @param {number|null} hcp       Handicap index
 * @param {string}      handed    'Right-handed' | 'Left-handed'
 * @param {string}      yardType  Club/profile yard preference: 'Carry' | 'Total'
 * @param {string}      yardMode  Active viz mode: 'carry' | 'total'
 * @returns {{
 *   id: string, label: string, carry: number, min: number, max: number,
 *   latH: number, rxR: number, rxL: number, tilt: number, off: number,
 *   ds: number, dl: number, pR: number, pL: number, pS: number, pLn: number
 * }|null}
 */
export function vizGetDisp(c, hcp, handed, yardType, yardMode) {
  const fk = vizFlightKey(c);
  if (!fk || !FLIGHT_DATA.clubs[fk]) return null;
  const fd   = FLIGHT_DATA.clubs[fk];
  const ti   = vizTierIdx(hcp);
  const bk   = c.bias || 'Straight';
  const b    = BIAS_DATA[bk] || BIAS_DATA['Straight'];
  const isL  = handed === 'Left-handed';
  const asym = VIZ_ASYM[bk]  || VIZ_ASYM.Straight;
  const lp   = VIZ_LPROB[bk] || VIZ_LPROB.Straight;
  const latH = Math.round(fd.latDisp[ti] / 2 * b.mult);

  const mins = (c.sessions || []).map(s => +s.min).filter(v => v > 0);
  const maxs = (c.sessions || []).map(s => +s.max).filter(v => v > 0);
  const avg  = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

  const loggedAsCarry = (c.yardType || yardType || 'Total') === 'Carry';
  const roll = VIZ_ROLL[fk]?.[ti] || 0;
  const toDisp = v => {
    if (!v) return 0;
    if (loggedAsCarry && yardMode === 'total')  return Math.round(v * (1 + roll));
    if (!loggedAsCarry && yardMode === 'carry') return Math.round(v / (1 + roll));
    return v;
  };

  const minD = toDisp(avg(mins));
  const maxD = toDisp(avg(maxs));

  return {
    id:    c.id,
    label: c.identifier || c.id,
    carry: Math.round((minD + maxD) / 2),
    min:   minD,
    max:   maxD,
    latH,
    rxR:  latH * (1 - (isL ? asym.lf : asym.rf)),
    rxL:  latH * (1 + (isL ? asym.rf : asym.lf)),
    tilt: asym.td * (isL ? -1 : 1),
    off:  b.offset * (isL ? -1 : 1),
    ds:   fd.depShort[ti],
    dl:   fd.depLong[ti],
    pR:   isL ? lp.pl : lp.pr,
    pL:   isL ? lp.pr : lp.pl,
    pS:   VIZ_LP[ti].s,
    pLn:  VIZ_LP[ti].l
  };
}
