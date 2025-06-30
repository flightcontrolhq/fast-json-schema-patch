export interface Product {
  id: string;
  name: string;
  sku: string;
  description: string;
  price: number;
  categoryIds: string[];
  attributes?: Record<string, any>;
  inventoryLevel: number;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  metadata?: Record<string, any>;
}

export interface ShippingRate {
  country: string;
  method: string;
  cost: number;
  estimatedDays?: number;
}

export interface EcommerceConfig {
  store: {
    name: string;
    currency: string;
    locale: string;
    logoUrl?: string;
    supportEmail?: string;
  };
  features?: {
    guestCheckout?: boolean;
    reviewsEnabled?: boolean;
    relatedProducts?: boolean;
  };
  analytics?: {
    googleAnalyticsId?: string;
    trackUserBehavior?: boolean;
  };
  payments: {
    supportedMethods: string[];
    stripe?: {
      apiKey: string;
      webhookSecret: string;
    };
    paypal?: {
      clientId: string;
      clientSecret: string;
    };
  };
  inventory: {
    thresholdAlert: number;
    autoRestock?: boolean;
    restockLevel?: number;
  };
  shipping: {
    rates: ShippingRate[];
    freeOver?: number;
  };
  products: Product[];
  categories: Category[];
  users: User[];
} 