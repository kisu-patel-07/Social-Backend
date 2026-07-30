import {
  ICoupon,
  CouponModel,
  ICouponRedemption,
  CouponRedemptionModel,
} from '../models/coupon.model';
import { BaseRepository } from './base.repository';

class CouponRepository extends BaseRepository<ICoupon> {
  constructor() {
    super(CouponModel);
  }

  findByCode(code: string): Promise<ICoupon | null> {
    return this.findOne({ code: code.trim().toUpperCase() });
  }
}

class CouponRedemptionRepository extends BaseRepository<ICouponRedemption> {
  constructor() {
    super(CouponRedemptionModel);
  }
}

export const couponRepository = new CouponRepository();
export const couponRedemptionRepository = new CouponRedemptionRepository();
