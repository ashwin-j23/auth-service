import { Toaster } from 'sonner';
import { useThemeStore } from '../../store/themeStore';

export function ToasterWithTheme() {
  const theme = useThemeStore((s) => s.theme);
  return (
    <Toaster
      position="top-right"
      richColors
      closeButton
      theme={theme}
      toastOptions={{
        duration: 5000,
        className: 'font-sans',
      }}
    />
  );
}
