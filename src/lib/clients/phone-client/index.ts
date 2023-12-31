import EventEmitter from 'eventemitter3'
import { UserAgent, Registerer, Inviter, Web, RegistererState, TransportState } from 'sip.js'
import { getUserMedia } from '$lib/clients/utils'
import { generateDummyStream } from '$lib/clients/utils/generate-dummy-stream'

interface PhoneClient extends EventEmitter {
	on(event: 'track', listener: (event: MediaStreamTrack) => void): this
	on(event: 'sender', listener: (event: RTCRtpSender) => void): this
	once(event: 'track', listener: (event: MediaStreamTrack) => void): this
	once(event: 'sender', listener: (event: RTCRtpSender) => void): this
	emit(event: 'track', track: MediaStreamTrack): boolean
	emit(event: 'sender', sender: RTCRtpSender): boolean
}

class PhoneClient extends EventEmitter {
	private _ua: UserAgent
	private _registerer?: Registerer
	private sip_server: string
	private got_user_media = false

	public get ua() {
		return this._ua
	}

	public get registerer() {
		return this._registerer
	}

	constructor(params: {
		username: string
		login?: string
		password: string
		sip_server: string
		ws_server?: string
	}) {
		super()

		const { username, login, password, sip_server, ws_server } = params

		this.sip_server = sip_server

		this._ua = new UserAgent({
			sessionDescriptionHandlerFactory: Web.defaultSessionDescriptionHandlerFactory(
				this.mediaStreamFactory
			),
			authorizationUsername: login ?? username,
			authorizationPassword: password,
			transportOptions: { server: ws_server ?? `wss://${sip_server}:8089/ws` },
			uri: UserAgent.makeURI(`sip:${username}@${sip_server}`)
		})

		this.ua.transport.stateChange.addListener(async (state) => {
			if (state === TransportState.Connected) {
				console.debug('REGISTERING')
				this._registerer = new Registerer(this._ua)
				await this._registerer.register()
			}
		})
	}

	public async start() {
		await this._ua.start()
	}

	public async stop() {
		if (this._registerer?.state === RegistererState.Registered) {
			console.debug('UNREGISTERING')
			this.registerer?.unregister()
		}
		await this._ua.stop()
	}

	public makeInviter(number: string) {
		const target = UserAgent.makeURI(`sip:${number}@${this.sip_server}`)
		if (!target) throw Error('Target Was Undefined')

		const inviter = new Inviter(this._ua, target, {
			sessionDescriptionHandlerOptions: {
				constraints: { audio: true }
			}
		})

		return inviter
	}

	private mediaStreamFactory: Web.MediaStreamFactory = async (
		constraints,
		sessionDescriptionHandler
	) => {
		if (!constraints.audio && !constraints.video) {
			return Promise.resolve(new MediaStream())
		}

		if (navigator.mediaDevices === undefined) {
			return Promise.reject(new Error('Media devices not available in insecure contexts.'))
		}

		if (!this.got_user_media) {
			await getUserMedia({ audio: true })
			this.got_user_media = true
		}

		sessionDescriptionHandler.close = () => {
			const { peerConnection, dataChannel } = sessionDescriptionHandler

			if (peerConnection === undefined) return

			for (const receiver of peerConnection.getReceivers()) {
				receiver.track && receiver.track.stop()
			}

			dataChannel?.close()
			if (peerConnection.signalingState !== 'closed') peerConnection.close()
		}

		sessionDescriptionHandler.peerConnectionDelegate = {
			ontrack: () => {
				const { remoteMediaStream, peerConnection } = sessionDescriptionHandler
				const [track] = remoteMediaStream.getAudioTracks()
				const [sender] = peerConnection!.getSenders().filter((s) => s.track?.kind === 'audio')
				this.emit('track', track)
				this.emit('sender', sender)
			}
		}

		return Promise.resolve(generateDummyStream())
	}
}

export { PhoneClient }
export default PhoneClient
