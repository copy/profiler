/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import {
  changeTimelineTrackOrganization,
  viewProfile,
} from '../../actions/receive-profile';
import {
  getHumanReadableActiveTabTracks,
  getProfileWithNiceTracks,
} from '../fixtures/profiles/tracks';
import {
  getScreenshotTrackProfile,
  addActiveTabInformationToProfile,
  addMarkersToThreadWithCorrespondingSamples,
  getProfileWithThreadCPUDelta,
} from '../fixtures/profiles/processed-profile';
import { storeWithProfile, blankStore } from '../fixtures/stores';
import { getView } from '../../selectors/app';
import {
  getTimelineTrackOrganization,
  getTimelineType,
} from '../../selectors/url-state';
import { stateFromLocation } from '../../app-logic/url-handling';

import type { Profile } from 'firefox-profiler/types';

describe('ActiveTab', function () {
  function setup(p = getProfileWithNiceTracks(), addInnerWindowID = true) {
    const { profile, ...pageInfo } = addActiveTabInformationToProfile(p);
    // Add the innerWindowIDs so we can compute the first thread as main track.
    if (addInnerWindowID) {
      profile.threads[0].frameTable.innerWindowID[0] =
        pageInfo.parentInnerWindowIDsWithChildren;
      if (profile.threads[0].frameTable.length < 1) {
        profile.threads[0].frameTable.length = 1;
      }
    }

    const { dispatch, getState } = storeWithProfile(profile);
    dispatch(
      changeTimelineTrackOrganization({
        type: 'active-tab',
        tabID: pageInfo.activeTabID,
      })
    );

    return {
      // Store:
      dispatch,
      getState,
      // TabIDs and InnerWindowIDs of pages:
      ...pageInfo,
    };
  }

  describe('global tracks', function () {
    it('can initialize with active tab information', function () {
      const { getState } = setup();
      expect(getHumanReadableActiveTabTracks(getState())).toEqual([
        'main track [tab] SELECTED',
      ]);
    });

    it('can extract a screenshots track', function () {
      const profile = getScreenshotTrackProfile();
      profile.threads[0].name = 'GeckoMain';
      const { getState } = setup(profile);
      expect(getHumanReadableActiveTabTracks(getState())).toEqual([
        'screenshots',
        'screenshots',
        'main track [tab] SELECTED',
      ]);
    });

    it('do not rely on network markers while calculating the tracks', function () {
      // Network markers are not reliable to compute the tracks because some network
      // markers of an iframe comes from the parent frame. Therefore, their
      // innerWindowID will be the parent window's innerWindowID.
      const profile = getProfileWithNiceTracks();
      addMarkersToThreadWithCorrespondingSamples(profile.threads[0], [
        [
          'Load 1 will be filtered',
          7,
          8,
          {
            type: 'Network',
            URI: 'URI 1',
            id: 5,
            pri: 1,
            status: 'STATUS_STOP',
            startTime: 7,
            endTime: 8,
          },
        ],
      ]);
      const { getState } = setup(profile, false);

      expect(getHumanReadableActiveTabTracks(getState()).length).toBe(0);
    });
  });
});

describe('finalizeProfileView', function () {
  function setup({
    profile = addActiveTabInformationToProfile(getProfileWithNiceTracks())
      .profile,
    search,
    noPages,
    activeTabID,
  }: {
    profile?: Profile,
    search: string,
    noPages?: boolean,
    activeTabID?: number | null,
  }) {
    const newUrlState = stateFromLocation({
      pathname: '/public/FAKEHASH/calltree/',
      search: '?' + search,
      hash: '',
    });

    if (noPages) {
      delete profile.pages;
    }

    if (activeTabID !== undefined) {
      // Update the activeTabID if it's explicitly provided.
      profile.meta.configuration = {
        ...profile.meta.configuration,
        // null is represented by 0 for activeTab in the back-end.
        activeTabID: activeTabID ?? 0,
      };
    }

    // Create the store and dispatch the url state.
    const store = blankStore();
    store.dispatch({
      type: 'UPDATE_URL_STATE',
      newUrlState,
    });

    // Lastly, load the profile to test finalizeProfileView.
    store.dispatch(viewProfile(profile));
    return store;
  }

  it('loads the profile with only `view=active-tab` in active tab view', async function () {
    const { getState } = setup({ search: '?view=active-tab&v=5' });

    // Check if we can successfully finalized the profile view for active tab.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'active-tab',
      tabID: null,
    });
  });

  it('switches back to full view if there is no `pages` array', async function () {
    const { getState } = setup({
      search: '?view=active-tab&v=5',
      noPages: true,
    });

    // Check if we can successfully finalized the profile view for full view.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'full',
    });
  });

  it('switches back to full view if there is no `activeTabID` value', function () {
    const { getState } = setup({
      search: '?view=active-tab&v=5',
      activeTabID: null,
    });

    // Check if we can successfully finalized the profile view for full view.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'full',
    });
  });

  it('switches back to full view if there is no relevant page with the given `activeTabID` value', function () {
    const activeTabIDWithNoRelevantPage = 99999;
    const { getState } = setup({
      search: '?view=active-tab&v=5',
      activeTabID: activeTabIDWithNoRelevantPage,
    });

    // Check if we can successfully finalized the profile view for full view.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'full',
    });
  });

  it('sets the timeline type to "categories with CPU" if there are CPU usage values in the profile', function () {
    const { profile } = addActiveTabInformationToProfile(
      getProfileWithThreadCPUDelta([[1, 2]])
    );
    const { getState } = setup({
      profile,
      search: '?view=active-tab&v=5',
    });

    // Check if we can successfully finalized the profile view for active tab view.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'active-tab',
      tabID: null,
    });

    // Check if we have the 'cpu-categories' as the timelineType
    expect(getTimelineType(getState())).toBe('cpu-category');
  });

  it('sets the timeline type to "categories" if there are no CPU usage values in the profile', function () {
    const { getState } = setup({
      search: '?view=active-tab&v=5',
    });

    // Check if we can successfully finalized the profile view for active tab view.
    expect(getView(getState()).phase).toBe('DATA_LOADED');
    expect(getTimelineTrackOrganization(getState())).toEqual({
      type: 'active-tab',
      tabID: null,
    });

    // Check if we have the 'cpu-categories' as the timelineType
    expect(getTimelineType(getState())).toBe('category');
  });
});
