declare module '@react-native-vector-icons/material-icons' {
  import { ComponentType } from 'react';
  interface IconProps {
    name: string;
    size?: number;
    color?: string;
    style?: any;
  }
  const Icon: ComponentType<IconProps>;
  export default Icon;
}
