import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, PhoneOff, MicOff, Mic } from 'lucide-react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// Unanswered-call timeout: an incoming call left ringing (or an outgoing call
// nobody answers) is torn down automatically so stale offers can never be
// answered into a newer call and history stays accurate.
const RING_TIMEOUT_MS = 45000;

const CallModal = forwardRef(function CallModal(_, ref) {
  const { socket, emit, on, off } = useSocket();
  const { user } = useAuth();

  const [receivingCall, setReceivingCall] = useState(false);
  const [callerName, setCallerName] = useState('');
  const [callAccepted, setCallAccepted] = useState(false);
  const [callEnded, setCallEnded] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [calling, setCalling] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [activeCallTo, setActiveCallTo] = useState(null);

  const userAudio = useRef();
  const peerAudio = useRef();
  const connectionRef = useRef();
  const streamRef = useRef();
  const pendingSignalRef = useRef(null);
  const pendingCallerRef = useRef(null);
  const pendingIceRef = useRef([]);
  const callIdRef = useRef(null);
  const ringTimeoutRef = useRef(null);
  // Mirrors activeCallTo synchronously: deferred timeouts must read the
  // current target even when React has not re-rendered yet (stale closure).
  const activeCallToRef = useRef(null);

  const updateActiveCallTo = (value) => {
    activeCallToRef.current = value;
    setActiveCallTo(value);
  };

  const clearRingTimeout = () => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  };

  const cleanup = () => {
    clearRingTimeout();
    if (connectionRef.current) {
      connectionRef.current.close();
      connectionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    pendingSignalRef.current = null;
    pendingCallerRef.current = null;
    pendingIceRef.current = [];
    callIdRef.current = null;
    setReceivingCall(false);
    setCallAccepted(false);
    setCallerName('');
    updateActiveCallTo(null);
    setIsMuted(false);
    setCalling(false);
    setPeerConnected(false);
    // Note: callEnded intentionally survives cleanup so the terminated call
    // stays hidden until the next incoming call resets it.
  };

  const endCall = (emitEvent = true, reason = 'cancelled') => {
    setCallEnded(true);
    clearRingTimeout();
    if (emitEvent && activeCallToRef.current && socket) {
      emit('endCall', { to: activeCallToRef.current, callId: callIdRef.current, reason });
    }
    cleanup();
  };

  useEffect(() => {
    if (!socket) return;

    const handleIncoming = (data) => {
      // A fresh call resets any terminated-call state so the modal shows again.
      setCallEnded(false);
      pendingSignalRef.current = data.signal;
      pendingCallerRef.current = data.from;
      callIdRef.current = data.callId;
      setReceivingCall(true);
      setCallerName(data.callerName);
      updateActiveCallTo(data.from);
      // Auto-decline as "missed" if nobody answers before the timeout.
      // Checked via refs so a stale closure can never fire a wrong teardown:
      // callIdRef is nulled on cleanup and the peer exists once answered.
      clearRingTimeout();
      ringTimeoutRef.current = setTimeout(() => {
        if (callIdRef.current && !connectionRef.current) endCall(true, 'missed');
      }, RING_TIMEOUT_MS);
    };

    const handleAccepted = (data) => {
      // Stale answers from a previous/concurrent call must never be applied
      // to the current peer connection.
      if (data.callId && callIdRef.current && data.callId !== callIdRef.current) return;
      if (connectionRef.current && !connectionRef.current._answered) {
        clearRingTimeout();
        connectionRef.current._answered = true;
        connectionRef.current
          .setRemoteDescription(new RTCSessionDescription(data.signal))
          .then(() => {
            // Flush ICE candidates that arrived while the answer was pending.
            // Stale candidates from a different call are skipped.
            for (const entry of pendingIceRef.current) {
              if (entry.callId && callIdRef.current && entry.callId !== callIdRef.current) continue;
              connectionRef.current.addIceCandidate(new RTCIceCandidate(entry.candidate)).catch((e) =>
                console.error('addIceCandidate error', e)
              );
            }
            pendingIceRef.current = [];
          })
          .catch((e) => console.error('setRemoteDescription error', e));
        setCalling(false);
        setCallAccepted(true);
      }
    };

    const handleIce = (data) => {
      // Candidates carry the callId — reject stale candidates from a
      // different (previous or concurrent) call so they can never be
      // flushed into the wrong connection.
      if (data.callId && callIdRef.current && data.callId !== callIdRef.current) {
        return;
      }
      const peer = connectionRef.current;
      // Candidates can arrive before the peer exists (callee has not answered
      // yet) or before the remote description is set. Buffer and flush later.
      if (!peer || !peer.remoteDescription) {
        pendingIceRef.current.push({ callId: data.callId, candidate: data.candidate });
        return;
      }
      peer.addIceCandidate(new RTCIceCandidate(data.candidate)).catch((e) =>
        console.error('addIceCandidate error', e)
      );
    };

    const handleEnded = () => {
      endCall(false);
    };

    on('incomingCall', handleIncoming);
    on('callAccepted', handleAccepted);
    on('iceCandidate', handleIce);
    on('callEnded', handleEnded);

    return () => {
      off('incomingCall', handleIncoming);
      off('callAccepted', handleAccepted);
      off('iceCandidate', handleIce);
      off('callEnded', handleEnded);
    };
  }, [socket, on, off]);

  useEffect(() => () => {
    connectionRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
  }, []);

  const getMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      streamRef.current = stream;
      if (userAudio.current) {
        userAudio.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error('Microphone access denied', err);
      return null;
    }
  };

  const createPeer = (stream, remoteUserId) => {
    const peer = new RTCPeerConnection(ICE_SERVERS);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.ontrack = (event) => {
      if (peerAudio.current) {
        peerAudio.current.srcObject = event.streams[0];
      }
    };

    peer.onicecandidate = (event) => {
      if (event.candidate && remoteUserId) {
        emit('iceCandidate', { to: remoteUserId, candidate: event.candidate, callId: callIdRef.current });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setPeerConnected(true);
      } else if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        endCall(false);
      }
    };

    connectionRef.current = peer;
    return peer;
  };

  const startCall = async (targetUserId, targetName, conversationId) => {
    if (!conversationId) return;
    const stream = await getMedia();
    if (!stream) return;

    setCalling(true);
    setCallerName(targetName);
    updateActiveCallTo(targetUserId);
    setCallAccepted(false);
    setCallEnded(false);
    setPeerConnected(false);

    const peer = createPeer(stream, targetUserId);
    const callId = crypto.randomUUID();
    callIdRef.current = callId;

    peer._answered = false;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    // Cancel with "cancelled" if the callee never answers.
    clearRingTimeout();
    ringTimeoutRef.current = setTimeout(() => {
      if (connectionRef.current && !connectionRef.current._answered) {
        endCall(true, 'cancelled');
      }
    }, RING_TIMEOUT_MS);

    emit('callUser', {
      userToCall: targetUserId,
      signalData: offer,
      conversationId,
      callId,
    });
  };

  useImperativeHandle(ref, () => ({
    startCall,
  }));

  const answerCall = async () => {
    const signal = pendingSignalRef.current;
    if (!signal) return;

    setCallAccepted(true);

    try {
      const stream = await getMedia();
      if (!stream) {
        endCall(true, 'rejected');
        return;
      }

      const peer = createPeer(stream, activeCallTo);
      peer._answered = true;

      await peer.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      // Flush ICE candidates that arrived before the call was answered.
      // Stale candidates from a different call are skipped.
      for (const entry of pendingIceRef.current) {
        if (entry.callId && callIdRef.current && entry.callId !== callIdRef.current) continue;
        peer.addIceCandidate(new RTCIceCandidate(entry.candidate)).catch((e) =>
          console.error('addIceCandidate error', e)
        );
      }
      pendingIceRef.current = [];

      clearRingTimeout();

      emit('answerCall', { signal: answer, to: activeCallTo, callId: callIdRef.current });
    } catch (err) {
      console.error('Failed to answer call', err);
      // Notify the caller so they are not stranded on "Calling...".
      endCall(true, 'cancelled');
    }
  };

  const toggleMute = () => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const showModal = receivingCall || calling || callAccepted;
  if (!showModal || callEnded) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20, x: '-50%' }}
        animate={{ opacity: 1, y: 0, x: '-50%' }}
        exit={{ opacity: 0, y: -20, x: '-50%' }}
        data-testid="call-modal"
        className="call-modal fixed top-5 left-1/2 z-[10000] p-6 min-w-[320px] text-center"
      >
        <audio playsInline ref={userAudio} autoPlay muted />
        <audio playsInline ref={peerAudio} autoPlay />

        {calling && !callAccepted && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 grid place-items-center text-white text-2xl font-bold animate-pulse">
              {callerName?.[0]?.toUpperCase()}
            </div>
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100">Calling...</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">{callerName}</p>
            <button
              onClick={() => endCall(true, 'cancelled')}
              className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition text-sm font-medium"
            >
              <PhoneOff className="w-4 h-4" /> Cancel
            </button>
          </div>
        )}

        {!callAccepted && receivingCall && !calling && (
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 grid place-items-center text-white text-2xl font-bold">
                {callerName?.[0]?.toUpperCase()}
              </div>
              <span className="absolute inset-0 rounded-full border-2 border-emerald-400/60 pulse-ring" />
            </div>
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100">Incoming Call</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-semibold">{callerName}</p>
            <div className="flex gap-3 mt-2">
              <button
                onClick={answerCall}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition text-sm font-medium"
              >
                <Phone className="w-4 h-4" /> Accept
              </button>
              <button
                onClick={() => endCall(true, 'rejected')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition text-sm font-medium"
              >
                <PhoneOff className="w-4 h-4" /> Decline
              </button>
            </div>
          </div>
        )}

        {callAccepted && (
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 grid place-items-center text-white text-2xl font-bold">
                {callerName?.[0]?.toUpperCase()}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900" />
            </div>
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100">Active Call</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-semibold">{callerName}</p>
            <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <span className={`w-1.5 h-1.5 rounded-full ${peerConnected ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
              {peerConnected ? 'Connected' : 'Connecting...'}
            </span>
            <div className="flex gap-3 mt-2">
              <button
                onClick={toggleMute}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-full transition text-sm font-medium ${
                  isMuted
                    ? 'bg-amber-500 text-white hover:bg-amber-600'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 dark:bg-slate-700/60 dark:text-slate-100 dark:hover:bg-slate-600/60 dark:border-slate-600'
                }`}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                onClick={() => endCall(true, 'completed')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition text-sm font-medium"
              >
                <PhoneOff className="w-4 h-4" /> End Call
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
});

export default CallModal;
