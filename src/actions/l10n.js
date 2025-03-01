/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import { negotiateLanguages } from '@fluent/langneg';
import { ReactLocalization } from '@fluent/react';
import type { Action, ThunkAction, Localization } from 'firefox-profiler/types';
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  fetchMessages,
  lazilyParsedBundles,
  getLocaleDirection,
} from 'firefox-profiler/app-logic/l10n';

/**
 * Notify that translations for the UI are being fetched.
 */
export function requestL10n(): Action {
  return {
    type: 'REQUEST_L10N',
  };
}

/**
 * Receive translations for a locale.
 */
export function receiveL10n(
  localization: Localization,
  primaryLocale: string,
  direction: 'ltr' | 'rtl'
): Action {
  return {
    type: 'RECEIVE_L10N',
    localization: localization,
    primaryLocale,
    direction,
  };
}

/**
 * This function is called when the AppLocalizationProvider is mounted.
 * It takes the locales available and generates l10n bundles for those locales.
 * Initially it dispatches the info that translations are now fetching and
 * later it dispacthes the translations and updates the state
 */
export function setupLocalization(
  locales: Array<string>,
  pseudoStrategy?: 'accented' | 'bidi'
): ThunkAction<Promise<void>> {
  return async (dispatch) => {
    dispatch(requestL10n());

    // Setting defaultLocale to `en-US` means that it will always be the
    // last fallback locale, thus making sure the UI is always working.
    const languages = negotiateLanguages(locales, AVAILABLE_LOCALES, {
      defaultLocale: DEFAULT_LOCALE,
    });

    // It's important to note that `languages` is the result of the negotiation,
    // and can be different than `locales`.
    // languages may contain the requested locale as well as some fallback
    // locales. Also `negotiateLanguages` always adds the default locale if it's
    // not present.
    // Some examples:
    // * navigator.locales == ['fr', 'en-US', 'en'] => languages == ['fr-FR', 'en-US', 'en-GB']
    // * navigator.locales == ['fr'] => languages == ['fr-FR', 'en-US']
    // Because our primary locale is en-US it's not useful to go past it and
    // fetch more locales than necessary, so let's slice to that entry.
    const indexOfDefaultLocale = languages.indexOf(DEFAULT_LOCALE); // Guaranteed to be positive
    const localesToFetch = languages.slice(0, indexOfDefaultLocale + 1);
    const fetchedMessages = await Promise.all(
      localesToFetch.map(fetchMessages)
    );
    const bundles = lazilyParsedBundles(fetchedMessages, pseudoStrategy);
    const localization = new ReactLocalization(bundles);

    const primaryLocale = languages[0];
    const direction = getLocaleDirection(primaryLocale, pseudoStrategy);
    dispatch(receiveL10n(localization, primaryLocale, direction));
  };
}
