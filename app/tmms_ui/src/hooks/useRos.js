import { useState, useEffect } from 'react'
import { ros } from '../services/rosbridge'

export function useRos() {
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onConnection = () => { setConnected(true);  setError(null) }
    const onError      = (e) => { setConnected(false); setError(String(e)) }
    const onClose      = ()  => { setConnected(false) }

    ros.on('connection', onConnection)
    ros.on('error',      onError)
    ros.on('close',      onClose)

    // Reflect initial state if ros already connected at mount time
    if (ros.isConnected) setConnected(true)

    return () => {
      ros.off('connection', onConnection)
      ros.off('error',      onError)
      ros.off('close',      onClose)
    }
  }, [])

  return { connected, error }
}
