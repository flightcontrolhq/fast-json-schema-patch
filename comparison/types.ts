// Enhanced Types and Interfaces
export enum ModificationComplexity {
  SIMPLE = 1, // Single property changes
  MEDIUM = 5, // Service additions/removals, multi-property changes
  COMPLEX = 10, // Environment changes, dependency chains, batch operations
}

export interface BenchmarkMetrics {
  library: string;
  patchCount: number;
  patchSize: number;
  executionTime: number;
  memoryUsage: number;
  accuracy: boolean;
  compressionRatio: number;
  complexityScore: number;
  operationType: string;
  documentSize: number;
  semanticAccuracy: number;
  iteration: number;
}

export interface FormattedDiffMetrics {
  library: string;
  executionTime: number;
  memoryUsage: number;
  outputSize: number;
  compressionRatio: number;
  complexityScore: number;
  operationType: string;
  documentSize: number;
  iteration: number;
}

export interface PerformanceStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

export interface SchemaAdvantageMetrics {
  typeAwareOptimizations: number;
  arrayOrderingConsistency: number;
  schemaConstraintValidation: number;
  semanticUnderstanding: number;
  compressionEfficiency: number;
}

export interface ModificationDescriptor {
  name: string;
  complexity: ModificationComplexity;
  operationType: string;
  cost: number;
  modify: (doc: any) => void;
} 

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