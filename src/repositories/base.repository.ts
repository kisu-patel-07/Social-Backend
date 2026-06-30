import {
  Document,
  FilterQuery,
  Model,
  PipelineStage,
  PopulateOptions,
  ProjectionType,
  QueryOptions,
  Types,
  UpdateQuery,
} from 'mongoose';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { buildPaginationMeta } from '../utils/pagination';

/**
 * Generic repository implementing the Repository Pattern over a Mongoose model.
 * Concrete repositories extend this to add domain-specific queries, keeping
 * data-access logic out of the service layer.
 */
export abstract class BaseRepository<T extends Document> {
  protected constructor(protected readonly model: Model<T>) {}

  create(data: Partial<T>): Promise<T> {
    return this.model.create(data);
  }

  insertMany(data: Partial<T>[]): Promise<T[]> {
    return this.model.insertMany(data) as unknown as Promise<T[]>;
  }

  findById(
    id: string | Types.ObjectId,
    projection?: ProjectionType<T>,
    options?: QueryOptions<T>
  ): Promise<T | null> {
    return this.model.findById(id, projection, options).exec();
  }

  findOne(
    filter: FilterQuery<T>,
    projection?: ProjectionType<T>,
    options?: QueryOptions<T>
  ): Promise<T | null> {
    return this.model.findOne(filter, projection, options).exec();
  }

  find(
    filter: FilterQuery<T>,
    projection?: ProjectionType<T>,
    options?: QueryOptions<T>
  ): Promise<T[]> {
    return this.model.find(filter, projection, options).exec();
  }

  count(filter: FilterQuery<T> = {}): Promise<number> {
    return this.model.countDocuments(filter).exec();
  }

  exists(filter: FilterQuery<T>): Promise<boolean> {
    return this.model
      .exists(filter)
      .exec()
      .then((res) => Boolean(res));
  }

  updateById(
    id: string | Types.ObjectId,
    update: UpdateQuery<T>,
    options: QueryOptions<T> = { new: true }
  ): Promise<T | null> {
    return this.model.findByIdAndUpdate(id, update, options).exec();
  }

  updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options: QueryOptions<T> = { new: true }
  ): Promise<T | null> {
    return this.model.findOneAndUpdate(filter, update, options).exec();
  }

  deleteById(id: string | Types.ObjectId): Promise<T | null> {
    return this.model.findByIdAndDelete(id).exec();
  }

  deleteMany(filter: FilterQuery<T>): Promise<number> {
    return this.model
      .deleteMany(filter)
      .exec()
      .then((res) => res.deletedCount ?? 0);
  }

  aggregate<R = unknown>(pipeline: PipelineStage[]): Promise<R[]> {
    return this.model.aggregate<R>(pipeline).exec();
  }

  /**
   * Run a filtered, paginated query. Returns the page of items plus
   * standardized pagination metadata.
   */
  async paginate(
    filter: FilterQuery<T>,
    options: PaginationOptions,
    projection?: ProjectionType<T>,
    populate?: PopulateOptions | (string | PopulateOptions)[]
  ): Promise<PaginatedResult<T>> {
    const query = this.model
      .find(filter, projection)
      .sort(options.sort)
      .skip(options.skip)
      .limit(options.limit);

    if (populate) {
      query.populate(populate);
    }

    const [items, total] = await Promise.all([
      query.exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { items, meta: buildPaginationMeta(total, options) };
  }
}
