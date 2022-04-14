import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWallet, faClockRotateLeft, faChartColumn, faMessage, faBook, faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { faTwitter, faDiscord, faTelegram, faGithub } from '@fortawesome/free-brands-svg-icons';
import { Link } from 'react-router-dom';
import TypeButtonsComponent from '../components/type-buttons/type-buttons.component';
import './menu.layout.scss';

interface Params {
    showMenu: boolean,
    setShowMenu: (showMenu: boolean) => void
}

function Menu({ showMenu, setShowMenu }: Params) {
    return <>
        <div className={'menu-container' + (!showMenu ? ' menu-hidden' : '')}>
            <div className='menu'>
                <div className='menu-content'>
                    <div className='menu-type-buttons'>
                        <TypeButtonsComponent />
                    </div>
                    <ul className='menu-list'>
                        <li><Link to="/"><p className="icon"><FontAwesomeIcon icon={faWallet} /></p>Rewards</Link></li>
                        <li><Link to="/history"><p className="icon"><FontAwesomeIcon icon={faClockRotateLeft} /></p>History</Link></li>
                        <li><Link to="/dashboard"><p className="icon"><FontAwesomeIcon icon={faChartColumn} /></p>Dashboard</Link></li>
                        <hr />
                        <li><Link to="/feedback"><p className="icon"><FontAwesomeIcon icon={faMessage} /></p>Feedback</Link></li>
                        <li><a target='_blank' rel="noreferrer" href="http://medium.com">
                            <p className="icon"><FontAwesomeIcon icon={faBook} /></p>
                            Docs&nbsp;<FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                        </a></li>
                    </ul>
                    <div className='menu-filler'>
                    </div>
                    <div className="social">
                        <FontAwesomeIcon icon={faTwitter} />
                        <FontAwesomeIcon icon={faDiscord} />
                        <FontAwesomeIcon icon={faTelegram} />
                        <FontAwesomeIcon icon={faGithub} />
                    </div>
                </div>
            </div>
        </div>
        <div className={'gray-layer' + (!showMenu ? ' layer-hidden' : '')} onClick={() => setShowMenu(false)}></div>
    </>;
}

export default Menu;