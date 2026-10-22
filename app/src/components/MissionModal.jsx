import React, { useEffect } from 'react';
import { color } from "../constants/tailwind";

export function MissionModal({ children, onClose, size = 'default' }) {
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div style={styles.overlay} onMouseDown={onClose}>
      <div
        style={{
          ...styles.modal,
          ...(size === 'wide' ? styles.modalWide : null),
          ...(size === 'editor' ? styles.modalEditor : null),
        }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
        <button style={styles.closeButton} onClick={onClose} aria-label="Close modal">
          ×
        </button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'linear-gradient(180deg, rgba(3, 5, 10, 0.52) 0%, rgba(6, 8, 16, 0.74) 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    zIndex: 9999,
    backdropFilter: 'blur(9px) saturate(120%)',
    WebkitBackdropFilter: 'blur(9px) saturate(120%)'
  },
  modal: {
    background: `linear-gradient(180deg, ${color.card} 0%, ${color.background} 100%)`,
    padding: '24px',
    borderRadius: '16px',
    position: 'relative',
    width: '100%',
    maxWidth: '620px',
    maxHeight: 'calc(100vh - 40px)',
    border: `1px solid ${color.borderStrong}`,
    zIndex: 10000,
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  modalWide: {
    maxWidth: 'min(1440px, calc(100vw - 32px))',
    minHeight: 'min(920px, calc(100vh - 40px))',
  },
  modalEditor: {
    maxWidth: '1200px',
  },
  closeButton: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '32px',
    height: '32px',
    borderRadius: '9999px',
    border: `1px solid ${color.border}`,
    background: 'rgba(255, 255, 255, 0.06)',
    color: color.text,
    fontSize: '22px',
    lineHeight: '1',
    cursor: 'pointer'
  }
};

