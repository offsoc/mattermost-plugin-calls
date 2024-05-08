import './component.scss';

import {UserSessionState} from '@mattermost/calls-common/lib/types';
import {UserProfile} from '@mattermost/types/users';
import {IDMappedObjects} from '@mattermost/types/utilities';
import React from 'react';
import {useIntl} from 'react-intl';
import {Participant} from 'src/components/call_widget/participant';

type Props = {
    sessions: UserSessionState[];
    profiles: IDMappedObjects<UserProfile>;
    callHostID: string;
    currentSession?: UserSessionState;
    screenSharingSession?: UserSessionState;
    callID?: string;
};

export const ParticipantsList = ({
    sessions,
    profiles,
    callHostID,
    currentSession,
    screenSharingSession,
    callID,
}: Props) => {
    const {formatMessage} = useIntl();

    const renderParticipants = () => {
        return sessions.map((session) => (
            <Participant
                key={session.session_id}
                session={session}
                profile={profiles[session.user_id]}
                isYou={session.session_id === currentSession?.session_id}
                isHost={callHostID === session.user_id}
                iAmHost={currentSession?.user_id === callHostID}
                isSharingScreen={screenSharingSession?.session_id === session.session_id}
                callID={callID}
            />
        ));
    };

    return (
        <div
            id='calls-widget-participants-menu'
            className='Menu'
        >
            <ul
                id='calls-widget-participants-list'
                className='Menu__content dropdown-menu'
                style={styles.participantsList}
            >
                <li
                    className='MenuHeader'
                    style={styles.participantsListHeader}
                >
                    {formatMessage({defaultMessage: 'Participants'})}
                </li>
                {renderParticipants()}
            </ul>
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = ({
    participantsList: {
        width: '100%',
        minWidth: 'revert',
        maxWidth: 'revert',
        maxHeight: '200px',
        overflow: 'auto',
        position: 'relative',
        borderRadius: '8px',
        border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)',
        boxShadow: 'none',

        /* @ts-ignore */
        appRegion: 'no-drag',
    },
    participantsListHeader: {
        position: 'sticky',
        top: '0',
        transform: 'translateY(-8px)',
        paddingTop: '16px',
        color: 'var(--center-channel-color)',
        background: 'var(--center-channel-bg)',

        /* @ts-ignore */
        appRegion: 'drag',
    },
});